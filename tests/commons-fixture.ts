/** Served Hearthwick fixtures, in layout tiles for the old rendering
 * harness. Function names remain until the T3/T4 scene fixtures are replaced;
 * production content always uses world tiles without translation.
 */
import { readFileSync } from 'node:fs';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import type { WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { PLACES } from '../src/lib/places.ts';
import { TILE } from '../src/lib/tile.ts';
import { anchorTile, assembleFootprint, commonsLane, exitOf, fixedChunkKeys, fixedNpcs, objectOut, serveFixed, type FixedDay, type FixedFootprint, type GateSlot, type CommonsFeatures } from '../src/game/wilds/fixed.ts';
import type { ExitDef, NpcId, NpcSpot, PropSpot } from '../src/game/worlds.ts';

export const COMMONS_PLACE = PLACES.fixed.find((f) => f.id === 'hearthwick')!;
const O = COMMONS_PLACE.origin;
/** The town's 72×72 layout frame. */
const MAP = { w: 72, h: 96 };

export function commonsFixtureBytes(cx: number, cy: number): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/hearthwick-${cx}-${cy}.bin`, import.meta.url)));
}

/** The nine town chunks, decoded and validated as the client does, row-major. */
export function commonsFixtureChunks(): WorldChunk[] {
  return fixedChunkKeys(COMMONS_PLACE).map(({ cx, cy }) => decodeChunk(commonsFixtureBytes(cx, cy)));
}

/** The game's footprint draws from the fixture, as if the server had served it. */
export function serveFixtureCommons(): FixedFootprint {
  serveFixtureLots();
  return serveFixed(COMMONS_PLACE, commonsFixtureChunks());
}

/** A world tile in Commons tiles. */
export const toCommons = (t: { tx: number; ty: number }) => ({ tx: t.tx - O.tx, ty: t.ty - O.ty });

/** The served Commons in Commons tiles: the old map's frame, what stands on it, its ways out and its lane. */
export interface CommonsView {
  width: number;
  height: number;
  widthPx: number;
  heightPx: number;
  ground: number[][];
  solid: boolean[][];
  trees: { tx: number; ty: number }[];
  bushes: { tx: number; ty: number }[];
  rocks: { tx: number; ty: number }[];
  props: PropSpot[];
  npcs: NpcSpot[];
  exits: ExitDef[];
  gates: GateSlot[];
  features: CommonsFeatures;
  /** The town spawn in layout tiles. */
  spawn: { tx: number; ty: number };
}

/** The served Commons on a day with nothing out (or `day`'s festival and wick), in Commons tiles. */
export function servedCommonsFixture(day: FixedDay = { festival: null, wick: 'Quiet' }): CommonsView {
  const fp = assembleFootprint(COMMONS_PLACE, commonsFixtureChunks());
  const at = (x: number, y: number) => ({ x: x + O.tx - fp.tx, y: y + O.ty - fp.ty });
  const ground = Array.from({ length: MAP.h }, (_, y) => Array.from({ length: MAP.w }, (_, x) => fp.ground[at(x, y).y]![at(x, y).x]!));
  const solid = Array.from({ length: MAP.h }, (_, y) => Array.from({ length: MAP.w }, (_, x) => fp.solid[at(x, y).y]![at(x, y).x]!));
  const view: CommonsView = { width: MAP.w, height: MAP.h, widthPx: MAP.w * TILE, heightPx: MAP.h * TILE, ground, solid, trees: [], bushes: [], rocks: [], props: [], npcs: [], exits: [], gates: [], features: null as never, spawn: toCommons(anchorTile('hearthwick:spawn')) };
  const onMap = (t: { tx: number; ty: number }) => t.tx >= 0 && t.ty >= 0 && t.tx < MAP.w && t.ty < MAP.h;
  for (const list of fp.objects.values())
    for (const o of list) {
      const t = toCommons(o);
      if (!onMap(t) || !objectOut(o, day)) continue;
      if (o.kind === 'tree') view.trees.push(t);
      if (o.kind === 'bush') view.bushes.push(t);
      if (o.kind === 'rock') view.rocks.push(t);
      if (o.prop) view.props.push({ frame: o.variant, ...t, h: o.prop.h, body: [o.prop.bodyW, o.prop.bodyH], ...(o.prop.light ? { light: o.prop.light } : {}) });
      if (o.kind === 'npc-post') view.npcs.push({ id: o.npc as NpcId, ...t, ...(o.spot ? { spot: o.spot } : {}) });
      const e = exitOf(o, fp);
      if (e) view.exits.push({ ...e, ...toCommons(e) });
    }
  if (!commonsLane()) serveFixtureCommons();
  const lane = commonsLane()!;
  view.gates = lane.gates.map((g) => ({ ...g, ...toCommons(g), sign: toCommons(g.sign), shelf: toCommons(g.shelf), entry: toCommons(g.entry) }));
  const f = lane.features;
  view.features = { gate: toCommons(f.gate), hame: toCommons(f.hame), well: toCommons(f.well), board: toCommons(f.board), silas: toCommons(f.silas), toolbox: toCommons(f.toolbox), firebox: toCommons(f.firebox), skids: toCommons(f.skids), lamps: f.lamps.map(toCommons) };
  return view;
}

/** World-coordinate geometry for the town scene tests, read from server fixtures. */
export function servedTownFixture(day: FixedDay = { festival: null, wick: 'Quiet' }): CommonsView {
  const fp = serveFixtureCommons()
  const view = servedCommonsFixture(day)
  const world = <T extends { tx: number; ty: number }>(t: T) => ({ ...t, tx: t.tx + O.tx, ty: t.ty + O.ty })
  const grid = <T>(g: T[][]): T[][] => new Proxy(g, { get(target, y) {
    if (typeof y === 'string' && /^-?\d+$/.test(y)) return new Proxy(target[Number(y) - fp.ty] ?? [], { get(row, x) {
      return typeof x === 'string' && /^-?\d+$/.test(x) ? row[Number(x) - fp.tx] : Reflect.get(row, x)
    } })
    return Reflect.get(target, y)
  } })
  return { ...view, ground: grid(fp.ground), solid: grid(fp.solid), trees: view.trees.map(world), bushes: view.bushes.map(world), rocks: view.rocks.map(world), props: view.props.map(world), npcs: fixedNpcs(), exits: view.exits.map(world), gates: [], features: commonsLane()!.features, spawn: anchorTile('hearthwick:spawn') }
}

/** All eight seeded lot chunks, served under a world-specific immutable identity. */
export function serveFixtureLots(): FixedFootprint {
  let result: FixedFootprint | null = null;
  for (const place of PLACES.fixed.filter(p => p.kind === 'plots')) result = serveFixed(place, Array.from({ length: 4 }, (_, row) => {
    const gate = row * 2 + (place.id === 'lots-east' ? 1 : 0);
    return decodeChunk(new Uint8Array(readFileSync(new URL(`./fixtures/plot-${gate}.bin`, import.meta.url))));
  }));
  return result!;
}
