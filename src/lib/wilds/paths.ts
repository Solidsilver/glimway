/**
 * Paths players make (docs/design/open-map.md section 3, decisions 5 and 7):
 * the rules for clearing, laying and lifting one tile, as the client checks
 * them before it sends (and predicts the answer). The server's twin is
 * server/internal/api/open_map_paths.go: it decides; these rules only keep
 * the client from offering what it would refuse, and say why in plain words.
 *
 * - Clear: brush or a thicket with a spade, a fallen trunk with an axe
 *   (content `paths.clearTools`). Only on land, never on a site, an entity
 *   or a landmark, never twice. Free, and it yields nothing.
 * - Lay: stone (1 stone) or plank (1 timber) on a walkable land tile that
 *   isn't laid yet. Not on water, a ford, the road or a site.
 * - Lift: only a path you laid. The stone or timber comes back; a tile that
 *   was solid before it was cleared stays cleared.
 *
 * No Phaser, no network.
 */
import { loadWilds } from './data.ts';
import type { WildsSurface } from './types.ts';

/** One tile as the rules read it: the generated land under it and the change on it now. */
export interface PathTile {
  /** The generated ground's surface (null where nothing is loaded). */
  surface: WildsSurface | null;
  /** The generated tile is solid (a thicket, a trunk, a tree). */
  baseSolid: boolean;
  /** Decor kinds anchored on the tile. */
  decor: readonly string[];
  /** A site, an entity or a place's landmark stands here. */
  occupied: boolean;
  /** The player-made change on the tile now (cleared, stone, plank), or null. */
  change: { change: string; by: string } | null;
  /** How many changes the tile's chunk holds now. */
  changes: number;
}

export type PathRefusal =
  | 'already-cleared'
  | 'not-clearable'
  | 'wrong-tool'
  | 'already-laid'
  | 'cannot-lay-here'
  | 'not-on-water'
  | 'insufficient-materials'
  | 'not-your-path'
  | 'too-far-away'
  | 'invalid-request';

export type PathCheck<T> = ({ ok: true } & T) | { ok: false; code: PathRefusal };

const paths = () => loadWilds().paths;

/** A lay kind's content entry (stone → laid-stone, 1 stone), or null. */
export function layKind(kind: string): { kind: string; ground: string; material: string; cost: number } | null {
  return paths().lay.find((l) => l.kind === kind) ?? null;
}

/** The lay kinds, in content order (stone, plank). */
export function layKinds(): readonly { kind: string; ground: string; material: string; cost: number }[] {
  return paths().lay;
}

/** Is this change a laid path (stone or plank)? */
export function isLaid(change: string | null | undefined): boolean {
  return !!change && layKind(change) !== null;
}

/** The tool action that clears the tile's decor (dig, chop), or null when nothing here clears. */
export function clearAction(decor: readonly string[]): string | null {
  let action: string | null = null;
  for (const kind of decor) for (const t of paths().clearTools) if (t.decor === kind) action = t.action;
  return action;
}

/** The decor kind the clear works on (thicket, log), for its words. */
export function clearDecor(decor: readonly string[]): string | null {
  let out: string | null = null;
  for (const kind of decor) if (paths().clearTools.some((t) => t.decor === kind)) out = kind;
  return out;
}

const full = (t: PathTile) => t.changes >= paths().maxChanges;
/** Walkable once its change is applied: open land, or cleared or laid. */
const walkable = (t: PathTile) => !t.baseSolid || t.change !== null;

/** Can this tile be cleared with the tools carried (`has(action)`)? */
export function checkClear(t: PathTile, has: (action: string) => boolean): PathCheck<{ action: string; decor: string }> {
  if (t.change) return { ok: false, code: 'already-cleared' };
  const action = clearAction(t.decor);
  if (!action || t.surface !== 'land' || t.occupied || full(t)) return { ok: false, code: 'not-clearable' };
  if (!has(action)) return { ok: false, code: 'wrong-tool' };
  return { ok: true, action, decor: clearDecor(t.decor)! };
}

/** Can a path of `kind` go here, with the materials held? */
export function checkLay(t: PathTile, kind: string, materials: Readonly<Record<string, number>>): PathCheck<{ material: string; cost: number; ground: string }> {
  const lay = layKind(kind);
  if (!lay) return { ok: false, code: 'invalid-request' };
  if (isLaid(t.change?.change)) return { ok: false, code: 'already-laid' };
  if (t.surface === 'water' || t.surface === 'ford') return { ok: false, code: 'not-on-water' };
  if (!walkable(t) || t.surface !== 'land' || t.occupied || (t.change === null && full(t))) return { ok: false, code: 'cannot-lay-here' };
  if ((materials[lay.material] ?? 0) < lay.cost) return { ok: false, code: 'insufficient-materials' };
  return { ok: true, material: lay.material, cost: lay.cost, ground: lay.ground };
}

/** Can `me` lift the path here? What the tile is after, and what comes back. */
export function checkLift(t: PathTile, me: string): PathCheck<{ kind: string; material: string; cost: number; after: 'cleared' | null }> {
  const lay = t.change && layKind(t.change.change);
  if (!t.change || !lay || t.change.by !== me) return { ok: false, code: 'not-your-path' };
  return { ok: true, kind: lay.kind, material: lay.material, cost: lay.cost, after: t.baseSolid ? 'cleared' : null };
}

/** Within reach of the hero's tile (content `paths.reachTiles`, measured as the server does). */
export function inReach(hero: { tx: number; ty: number }, tile: { tx: number; ty: number }): boolean {
  const r = paths().reachTiles;
  const dx = hero.tx - tile.tx;
  const dy = hero.ty - tile.ty;
  return dx * dx + dy * dy <= r * r;
}

// ------------------------------------------------------------ words

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** The tool a clear needs, with its article (a spade, an axe). */
export function toolWord(action: string): string {
  return action === 'chop' ? 'an axe' : action === 'break' ? 'a pick' : 'a spade';
}

/**
 * A refusal in plain words. `words` are content/wilds.json's; `extra` the
 * client's own lines by code (src/content/open-map.ts PATH_REFUSALS).
 */
export function refusalText(code: string, ctx: { action?: string; material?: string; extra: Readonly<Record<string, string>> }): string {
  const w = loadWilds().words;
  if (code === 'wrong-tool') return fill(w.needTool, { tool: toolWord(ctx.action ?? 'dig') });
  if (code === 'insufficient-materials') return fill(w.needMaterial, { material: ctx.material ?? 'stone' });
  if (code === 'not-on-water') return w.notOnWater;
  if (code === 'beyond-frontier') return w.drift;
  return ctx.extra[code] ?? ctx.extra.unknown ?? 'That didn’t take.';
}

/**
 * "This land turns in N days. A path here stays if someone walks here each wick." `endsAt` and `now`
 * are Unix seconds. N counts whole days, at least one ("a day").
 */
export function turnsInText(endsAt: number, now: number): string {
  const n = Math.max(1, Math.ceil((endsAt - now) / 86_400));
  const t = loadWilds().words.turnsIn;
  return n === 1 ? t.replace('{days} days', 'a day').replace('{days}', '1') : fill(t, { days: String(n) });
}

/** A way's sign: "Tansy's way. From the Tangle to the camp glade." */
export function waySignText(way: string, from: string, to: string): string {
  return fill(loadWilds().words.waySign, { way, from, to });
}

/** "Found by <name>". */
export function foundByText(name: string): string {
  return fill(loadWilds().words.foundBy, { name });
}

/** The first finder's line, with what they found ("Nobody's been here yet this wick. You find 2 stone."). */
export function firstFindText(loot: string): string {
  return fill(loadWilds().words.firstFind, { loot });
}

/**
 * A place's name for signs and the map: a footprint's own ("the Tangle"),
 * else its kind's with "the" ("the camp glade"), else "a place".
 */
export function placeName(id: string, kind: string | null): string {
  const w = loadWilds();
  const foot = w.places.find((p) => p.id === id);
  if (foot) return foot.name;
  const k = kind ? w.placeKinds.find((p) => p.id === kind) : null;
  if (!k) return 'a place';
  return k.name.replace(/^an? /, 'the ');
}
