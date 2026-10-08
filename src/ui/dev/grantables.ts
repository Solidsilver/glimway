/**
 * Dev mode (local playtesting only): everything the dev panel can give, from
 * Glimway's own content tables — embers, every item in content/items.json
 * (materials, tools, recipe pages, keepsakes, seeds…) and every home good in
 * content/homestead.json. Nothing from Habitica. The caps mirror the
 * server's (server/internal/api/dev_grant.go), which refuses anything else.
 * Imported only by the dev panel, which only Vite dev mode loads.
 */
import { ITEMS, assetKind, type ItemDef } from '../../lib/items.ts';
import { HOMESTEAD_DATA } from '../../lib/homestead.ts';
import { itemArt } from '../../lib/inventory.ts';

export type GrantKind = 'embers' | 'material' | 'item' | 'instance' | 'decoration';

export interface Grantable {
  id: string;
  name: string;
  kind: GrantKind;
  /** What the list says it is. */
  group: string;
  /** The most one grant may give (the server's cap). */
  max: number;
  /** Art key, and the icon when the art isn't drawn. */
  art: string | null;
  icon: string;
}

/** The server's caps: stacks and embers by the thousand, tools and home goods one at a time. */
export const GRANT_MAX: Record<GrantKind, number> = { embers: 100_000, material: 9999, item: 9999, instance: 20, decoration: 20 };

const GROUP: Record<string, string> = {
  material: 'Material',
  tool: 'Tool',
  'off-hand': 'Off hand',
  'carry-gear': 'Carry gear',
  fitting: 'Fitting',
  consumable: 'Consumable',
  part: 'Part',
  seed: 'Seed',
  keepsake: 'Keepsake',
  paper: 'Recipe page',
};

function fromItem(d: ItemDef): Grantable {
  const kind = assetKind(d);
  const pic = itemArt(d);
  return { id: d.id, name: d.name, kind, group: GROUP[d.kind] ?? d.kind, max: GRANT_MAX[kind], art: pic.art, icon: pic.icon };
}

/** Everything grantable: embers first, then items and home goods by name. */
export function grantables(): Grantable[] {
  const items = ITEMS.items.filter((d) => d.kind !== 'home-good').map(fromItem);
  const homes: Grantable[] = HOMESTEAD_DATA.items.map((h) => ({ id: h.id, name: h.name, kind: 'decoration', group: 'Home good', max: GRANT_MAX.decoration, art: null, icon: 'home' }));
  const byName = (a: Grantable, b: Grantable) => a.name.localeCompare(b.name);
  return [{ id: 'embers', name: 'Embers', kind: 'embers', group: 'Embers', max: GRANT_MAX.embers, art: null, icon: 'ember' }, ...[...items, ...homes].sort(byName)];
}

/** The list filtered by a search: every word must match the name, id or group. */
export function searchGrantables(list: readonly Grantable[], query: string): Grantable[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((g) => {
    const text = `${g.name} ${g.id} ${g.group}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Every material, a stack of `qty` each (the panel's quick button). */
export function everyMaterial(qty: number): { id: string; qty: number }[] {
  return ITEMS.items.filter((d) => d.kind === 'material').map((d) => ({ id: d.id, qty: Math.min(qty, GRANT_MAX.material) }));
}

/** A count within the thing's cap (1 at least). */
export function clampCount(g: Pick<Grantable, 'max'>, n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), g.max) : 1;
}
