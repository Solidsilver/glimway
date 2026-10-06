/**
 * Item definitions (content/items.json; docs/items/), typed and validated
 * the same way as the Go loader (content/items.go), plus the pure helpers
 * the inventory panel and the game use: grade rules, wear states, icons,
 * effects in words, pockets and the off hand. No Phaser, no network.
 */
import itemsRaw from '../../content/items.json' with { type: 'json' };
import { HOMESTEAD_DATA } from './homestead.ts';
import { loadWilds } from './wilds/data.ts';
import economy from '../../content/economy.json' with { type: 'json' };

export const ITEM_TABS = ['tools', 'supplies', 'keepsakes', 'home', 'papers'] as const;
export const ITEM_KINDS = ['tool', 'consumable', 'material', 'fitting', 'part', 'seed', 'keepsake', 'home-good', 'paper', 'off-hand', 'carry-gear'] as const;
export const FITTING_KINDS = ['bite', 'hold', 'heft', 'glow', 'grip', 'remember'] as const;
export const TOOL_ACTIONS = ['chop', 'break', 'dig', 'draw', 'water', 'trim', 'mark'] as const;
export const PLAYER_CLASSES = ['warrior', 'mage', 'healer', 'rogue'] as const;
export const USE_EFFECTS = ['restore-hp', 'restore-mana', 'clear-unmoored', 'ease-unmoored', 'wisps-forget', 'refill-lantern', 'light-post'] as const;
export const POCKET_EFFECTS = ['papers-glint', 'notice-later', 'gather-more', 'pond-skip', 'wend-gives-more'] as const;
export const HELD_EFFECTS = ['light', 'wisps-keep-off', 'compass', 'remedy-at-hand', 'whistle', 'papers-chime'] as const;
/** Use effects the game applies today; a consumable is usable when all of its are. */
export const IMPLEMENTED_USES: readonly string[] = ['restore-hp', 'restore-mana'];
export const PICKUP_AREAS = ['village', 'woodland', 'ruin', 'commons'] as const;

export type ItemTab = (typeof ITEM_TABS)[number];
export type ItemKind = (typeof ITEM_KINDS)[number];
export type FittingKind = (typeof FITTING_KINDS)[number];
export type PlayerClass = (typeof PLAYER_CLASSES)[number];
export type AtZero = 'breaks' | 'blunt' | 'cracked' | 'never';
/** How a tool looks and behaves now (server-computed; also the icon state). */
export type WearState = 'whole' | 'worn' | 'blunt' | 'cracked' | 'dull';

export interface ItemEffect {
  type: string;
  amount?: number;
  seconds?: number;
  target?: string;
}
export interface ItemDef {
  id: string;
  name: string;
  tab: ItemTab;
  kind: ItemKind;
  blurb: string;
  icon?: string;
  grade?: 'cheap' | 'heirloom' | 'special';
  uses?: number;
  atZero?: 'breaks' | 'blunt' | 'cracked';
  slots?: number;
  actions?: string[];
  repair?: { bench: Record<string, number>; mender?: Record<string, number>; menderEmbers?: number };
  fitting?: FittingKind;
  use?: ItemEffect[];
  pocket?: ItemEffect[];
  held?: ItemEffect[];
  affinity?: { class: PlayerClass; held: ItemEffect[] };
  offHand?: boolean;
  bound?: boolean;
  belongsTo?: string;
  marked?: boolean;
}
export interface ItemPickup {
  id: string;
  item: string;
  qty: number;
  area: (typeof PICKUP_AREAS)[number];
  tx: number;
  ty: number;
  usesLeft?: number;
  label: string;
  found: string;
}
export interface ItemMender {
  npc: string;
  name: string;
  area: string;
  tx: number;
  ty: number;
  radiusTiles: number;
}
export interface ItemRules {
  grades: Record<'cheap' | 'heirloom' | 'special', { slots: number; atZero: AtZero; bound?: boolean }>;
  wear: { pointsPerUse: number; holdPointsPerUse: number; fittingUses: number; wornBelowPercent: number; wardenDullUses: number };
  pockets: { base: number; withCarryGear: number };
  offHand: { tuckDuring: string[] };
  give: { radiusTiles: number };
  thanks: { nearbyTiles: number };
  menders: ItemMender[];
}
export interface Items {
  rules: ItemRules;
  items: ItemDef[];
  pickups: ItemPickup[];
}

const KIND_TAB: Record<ItemKind, ItemTab> = {
  tool: 'tools',
  'off-hand': 'tools',
  'carry-gear': 'tools',
  consumable: 'supplies',
  material: 'supplies',
  fitting: 'supplies',
  part: 'supplies',
  seed: 'supplies',
  keepsake: 'keepsakes',
  'home-good': 'home',
  paper: 'papers',
};
const INSTANCED: readonly ItemKind[] = ['tool', 'off-hand', 'carry-gear', 'fitting'];
const AT_ZERO_FOR_GRADE: Record<string, readonly string[]> = { cheap: ['breaks'], heirloom: ['blunt', 'cracked'], special: ['never'] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,100}$/.test(v);
const isInt = (v: unknown, min = 0, max = 1_000_000): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function validEffects(list: unknown, allowed: readonly string[]): boolean {
  if (list === undefined) return true;
  if (!Array.isArray(list)) return false;
  return list.every(
    (e) =>
      isObj(e) &&
      allowed.includes(e.type as string) &&
      (e.amount === undefined || isInt(e.amount, 0, 1000)) &&
      (e.seconds === undefined || isInt(e.seconds, 0, 86400)) &&
      (e.target === undefined || (typeof e.target === 'string' && e.target.length <= 100)) &&
      !((e.type === 'restore-hp' || e.type === 'restore-mana') && !isInt(e.amount, 1, 1000)),
  );
}

export const isInstanced = (d: Pick<ItemDef, 'kind'>): boolean => INSTANCED.includes(d.kind);
export const isStackable = (d: Pick<ItemDef, 'kind'>): boolean => !isInstanced(d) && d.kind !== 'home-good' && d.kind !== 'paper';

function validCosts(v: unknown, defs: Map<string, ItemDef>): boolean {
  if (!isObj(v) || Object.keys(v).length === 0) return false;
  return Object.entries(v).every(([id, n]) => {
    const d = defs.get(id);
    return !!d && isStackable(d) && isInt(n, 1);
  });
}

/** Throws on anything content/items.go would refuse. */
export function validateItems(value: unknown): Items {
  const bad = (why: string): never => {
    throw new Error(`invalid items: ${why}`);
  };
  if (!isObj(value) || !isObj(value.rules) || !Array.isArray(value.items) || !Array.isArray(value.pickups)) return bad('shape');
  const v = value as unknown as Items;
  const r = v.rules;
  if (!isObj(r.grades) || Object.keys(r.grades).length !== 3) return bad('grades');
  for (const [name, allowed] of Object.entries(AT_ZERO_FOR_GRADE)) {
    const g = (r.grades as Record<string, { slots: number; atZero: string }>)[name];
    if (!g || !allowed.includes(g.atZero) || !isInt(g.slots, 0, FITTING_KINDS.length)) return bad(`grade ${name}`);
  }
  const w = r.wear;
  if (!isObj(w) || !isInt(w.pointsPerUse, 1) || !isInt(w.holdPointsPerUse, 1, w.pointsPerUse) || !isInt(w.fittingUses, 1) || !isInt(w.wornBelowPercent, 1, 99) || !isInt(w.wardenDullUses, 1)) return bad('wear');
  if (!isInt(r.pockets?.base, 1) || !isInt(r.pockets.withCarryGear, r.pockets.base, 4) || !isInt(r.give?.radiusTiles, 1) || !isInt(r.thanks?.nearbyTiles, 1)) return bad('pockets');
  const npcs = new Set<string>();
  for (const m of r.menders ?? []) {
    if (!validId(m.npc) || !m.name || npcs.has(m.npc) || !(PICKUP_AREAS as readonly string[]).includes(m.area) || !isInt(m.tx) || !isInt(m.ty) || !isInt(m.radiusTiles, 1)) return bad(`mender ${m.npc}`);
    npcs.add(m.npc);
  }
  const defs = new Map<string, ItemDef>();
  for (const d of v.items) {
    if (!isObj(d) || !validId(d.id) || defs.has(d.id) || typeof d.name !== 'string' || !d.name || typeof d.blurb !== 'string' || !d.blurb || !ITEM_KINDS.includes(d.kind) || KIND_TAB[d.kind] !== d.tab || (d.icon !== undefined && !validId(d.icon))) return bad(`item ${String(d?.id)}`);
    defs.set(d.id, d);
  }
  for (const d of v.items) {
    const fail = (why: string): never => bad(`item ${d.id}: ${why}`);
    if (d.kind === 'tool') {
      const g = d.grade && r.grades[d.grade];
      if (!g) return fail('grade');
      if ((g.atZero === 'never') !== !d.uses || (d.uses !== undefined && !isInt(d.uses, 1, 10000))) return fail('uses');
      if (d.atZero !== undefined && !AT_ZERO_FOR_GRADE[d.grade!].includes(d.atZero)) return fail('atZero');
      if (d.slots !== undefined && !isInt(d.slots, 0, FITTING_KINDS.length)) return fail('slots');
      if (!Array.isArray(d.actions) || !d.actions.length || !d.actions.every((a) => (TOOL_ACTIONS as readonly string[]).includes(a))) return fail('actions');
      const zero = d.atZero ?? g.atZero;
      if ((zero === 'blunt' || zero === 'cracked') !== !!d.repair) return fail('repair');
      if (d.repair && (!validCosts(d.repair.bench, defs) || (d.repair.mender !== undefined && !validCosts(d.repair.mender, defs)) || (d.repair.menderEmbers !== undefined && !isInt(d.repair.menderEmbers)) || (!d.repair.mender && !d.repair.menderEmbers))) return fail('repair cost');
    } else if (d.grade !== undefined || d.uses !== undefined || d.atZero !== undefined || d.slots !== undefined || d.actions !== undefined || d.repair !== undefined) {
      return fail('tool fields on a non-tool');
    }
    if ((d.kind === 'fitting') !== (FITTING_KINDS as readonly string[]).includes(d.fitting as string)) return fail('fitting');
    if ((d.kind === 'consumable') !== !!d.use?.length || !validEffects(d.use, USE_EFFECTS)) return fail('use');
    if ((d.pocket?.length && d.kind !== 'keepsake') || !validEffects(d.pocket, POCKET_EFFECTS)) return fail('pocket');
    if (d.offHand && d.kind !== 'keepsake' && d.kind !== 'tool') return fail('offHand');
    if (!!d.held?.length !== offHandable(d) || !validEffects(d.held, HELD_EFFECTS)) return fail('held');
    if (d.affinity && (!(PLAYER_CLASSES as readonly string[]).includes(d.affinity.class) || !d.affinity.held?.length || !validEffects(d.affinity.held, HELD_EFFECTS) || !offHandable(d))) return fail('affinity');
    if (d.belongsTo !== undefined && (d.kind !== 'keepsake' || !validId(d.belongsTo))) return fail('belongsTo');
    if (d.kind === 'home-good' && HOMESTEAD_DATA.items.find((h) => h.id === d.id)?.name !== d.name) return fail('home good not in homestead.json');
  }
  const wilds = loadWilds();
  for (const m of wilds.materials) if (defs.get(m)?.kind !== 'material') bad(`wilds material ${m}`);
  for (const t of wilds.trinkets) if (defs.get(t)?.kind !== 'keepsake') bad(`wilds trinket ${t}`);
  if (defs.get(economy.charmItem)?.kind !== 'keepsake') bad('charm');
  const pickups = new Set<string>();
  for (const p of v.pickups) {
    const d = defs.get(p.item);
    if (
      !validId(p.id) || pickups.has(p.id) || !d || !(isStackable(d) || isInstanced(d)) || !isInt(p.qty, 1, 100) || (isInstanced(d) && p.qty !== 1) ||
      !(PICKUP_AREAS as readonly string[]).includes(p.area) || !isInt(p.tx) || !isInt(p.ty) || !p.label || !p.found ||
      (p.usesLeft !== undefined && (!isInt(p.usesLeft, 1) || d.kind !== 'tool' || p.usesLeft > (d.uses ?? 0)))
    ) return bad(`pickup ${p.id}`);
    pickups.add(p.id);
  }
  return v;
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

export function atZeroRule(d: ItemDef): AtZero {
  if (d.kind !== 'tool') return 'never';
  return d.atZero ?? ITEM_RULES.grades[d.grade ?? 'special'].atZero;
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
  return itemDef(id)?.icon ?? id;
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

/** "a comfrey salve", "2 Lamp Wicks", "a Nan's lamplighter pole". */
export function giftPhrase(itemId: string, qty: number): string {
  const name = itemName(itemId);
  // Names that start with a person or are already Title Case keep their capitals.
  const proper = /’s|'s/.test(name) || /^[A-Z][a-z]+ [A-Z]/.test(name);
  const shown = proper ? name : name.charAt(0).toLowerCase() + name.slice(1);
  if (qty === 1) return `${/^[aeiou]/i.test(shown) ? 'an' : 'a'} ${shown}`;
  return `${qty} ${shown}${shown.endsWith('s') ? '' : 's'}`;
}
