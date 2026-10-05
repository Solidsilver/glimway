/**
 * Wilds generator v1 — entities and loot are server-reproducible (integer
 * hash/PRNG only); terrain is client-only and may use floats, but is fully
 * deterministic from the same chunk seed.
 *
 * RNG consumption order (the Go port must match exactly):
 *
 *   chunkEntities: for each entity kind in data.entityKinds order —
 *     1. count = min + rng.nextInt(max - min + 1)
 *     2. per instance: placement draws (up to 64 attempts of
 *        tx = 2 + rng.nextInt(S - 4), ty = 2 + rng.nextInt(S - 4); a
 *        deterministic fallback scan uses no draws), then one kind-data draw
 *        (camp mix / node material / chest tier / poi id).
 *
 *   rollLoot: per loot-table entry in order — chance = rng.nextInt(1000) then
 *     qty = min + rng.nextInt(max - min + 1); entry is paid when
 *     chance < chancePermille. Then trinket chance = rng.nextInt(1000); the
 *     trinket id draw (rng.nextInt(trinkets.length)) happens only when won.
 *
 * Exit geometry (v1): each existing N/E/S/W neighbor gets a 3-tile gap
 * centered on that edge (mid = chunkSize / 2 - 1); the region entry chunk
 * additionally gets a `commons` gap on its south edge at tx = 1. Spawn is just
 * inside the commons gap on the entry chunk, else just inside the south,
 * north, west or east gap (first that exists).
 */
import { TILE } from '../../game/textures.ts';
import { DECOR_ART, TANGLE_GROUND, tangleTerrain } from './tangle.ts';
import { chunkSites, crossingExit, routeHome, seasonMark } from './outer.ts';
import { Rng, chunkSeed, lootSeed, type SeedEpoch } from './hash.ts';
import { loadWilds } from './data.ts';
import type {
  ChunkCoord,
  ChunkExit,
  ChunkTerrain,
  Epoch,
  ExitDir,
  LootDrop,
  MaterialQty,
  Tile,
  WildsData,
  WildsEntity,
  WildsEntityKind,
  WildsGenerator,
  WildsRegion,
} from './types.ts';

const ENTITY_KINDS: readonly WildsEntityKind[] = ['camp', 'node', 'chest', 'poi'];
const EXIT_GAP = 3;
const COMMONS_EXIT_TX = 1;
const PLACE_ATTEMPTS = 64;
const PLACE_MARGIN = 2;

function regionFor(data: WildsData, regionId: string): WildsRegion {
  const region = data.regions.find((r) => r.id === regionId);
  if (!region) throw new Error(`wilds: unknown region ${regionId}`);
  return region;
}

const tileKey = (tx: number, ty: number) => `${tx},${ty}`;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- exits

/** Chunk exits for (cx, cy): N/E/S/W where a neighbor exists, plus the
 *  commons way home on the region's entry chunk. Fixed order. */
export function buildExits(data: WildsData, region: WildsRegion, cx: number, cy: number): ChunkExit[] {
  const S = data.chunkSize;
  const mid = S / 2 - 1;
  const inward = {
    north: { tx: mid + 1, ty: 1 },
    east: { tx: S - 2, ty: mid + 1 },
    south: { tx: mid + 1, ty: S - 2 },
    west: { tx: 1, ty: mid + 1 },
    commons: { tx: COMMONS_EXIT_TX + 1, ty: S - 2 },
  };
  const out: ChunkExit[] = [];
  const push = (dir: ExitDir, tx: number, ty: number, tw: number, th: number, toChunk: ChunkCoord | null, entry: Tile) => {
    out.push({
      tx,
      ty,
      tw,
      th,
      to: toChunk === null ? 'commons' : `chunk:${region.id}:${toChunk.cx}:${toChunk.cy}`,
      entry,
      dir,
      toChunk,
    });
  };
  if (cy > 0) push('north', mid, 0, EXIT_GAP, 1, { cx, cy: cy - 1 }, { ...inward.south });
  if (cx < region.gridWidth - 1) push('east', S - 1, mid, 1, EXIT_GAP, { cx: cx + 1, cy }, { ...inward.west });
  if (cy < region.gridHeight - 1) push('south', mid, S - 1, EXIT_GAP, 1, { cx, cy: cy + 1 }, { ...inward.north });
  if (cx > 0) push('west', 0, mid, 1, EXIT_GAP, { cx: cx - 1, cy }, { ...inward.east });
  if (cx === region.entryX && cy === region.entryY) {
    push('south', COMMONS_EXIT_TX, S - 1, EXIT_GAP, 1, null, { ...inward.commons });
  }
  return out;
}

/** Just inside an exit mouth — where stepping through it lands in this chunk. */
export function exitInward(data: WildsData, e: ChunkExit): Tile {
  const S = data.chunkSize;
  const mid = S / 2 - 1;
  switch (e.dir) {
    case 'north':
      return { tx: e.tx + 1, ty: 1 };
    case 'south':
      return { tx: e.tx + 1, ty: S - 2 };
    case 'west':
      return { tx: 1, ty: e.ty + 1 };
    case 'east':
      return { tx: S - 2, ty: e.ty + 1 };
    default:
      return { tx: mid + 1, ty: S - 2 };
  }
}

/** True on an exit tile or the one-tile margin around it (never occupied). */
function nearAnyExit(exits: readonly ChunkExit[], tx: number, ty: number): boolean {
  return exits.some((e) => tx >= e.tx - 1 && tx <= e.tx + e.tw && ty >= e.ty - 1 && ty <= e.ty + e.th);
}

function spawnTile(data: WildsData, exits: readonly ChunkExit[]): Tile {
  const order: ExitDir[] = ['south', 'north', 'west', 'east'];
  // The way home (the Commons gap, or the outer entry's gap back over the crossing).
  const commons = exits.find((e) => e.to === 'commons' || (e.toRegion !== undefined && e.dir === 'south' && e.tx === COMMONS_EXIT_TX));
  if (commons) return exitInward(data, commons);
  for (const dir of order) {
    const e = exits.find((x) => x.dir === dir && x.to !== 'commons');
    if (e) return exitInward(data, e);
  }
  throw new Error('wilds: chunk has no exits');
}

// ---------------------------------------------------------------- entities

function spotFree(exits: readonly ChunkExit[], occupied: readonly Tile[], tx: number, ty: number): boolean {
  if (nearAnyExit(exits, tx, ty)) return false;
  return !occupied.some((p) => Math.abs(p.tx - tx) < 2 && Math.abs(p.ty - ty) < 2);
}

function placeEntity(rng: Rng, data: WildsData, exits: readonly ChunkExit[], occupied: readonly Tile[]): Tile {
  const S = data.chunkSize;
  const room = S - 2 * PLACE_MARGIN;
  for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
    const tx = PLACE_MARGIN + rng.nextInt(room);
    const ty = PLACE_MARGIN + rng.nextInt(room);
    if (spotFree(exits, occupied, tx, ty)) return { tx, ty };
  }
  for (let ty = PLACE_MARGIN; ty <= S - PLACE_MARGIN - 1; ty++) {
    for (let tx = PLACE_MARGIN; tx <= S - PLACE_MARGIN - 1; tx++) {
      if (spotFree(exits, occupied, tx, ty)) return { tx, ty };
    }
  }
  throw new Error('wilds: no room left for an entity in chunk');
}

function parseEntityId(entityId: string): { kind: WildsEntityKind; cx: number; cy: number; index: number } {
  const parts = entityId.split(':');
  if (parts.length !== 4 || !(ENTITY_KINDS as readonly string[]).includes(parts[0])) {
    throw new Error(`wilds: bad entity id ${entityId}`);
  }
  const cx = Number(parts[1]);
  const cy = Number(parts[2]);
  const index = Number(parts[3]);
  if (![cx, cy, index].every((n) => Number.isSafeInteger(n)) || index < 0) {
    throw new Error(`wilds: bad entity id ${entityId}`);
  }
  return { kind: parts[0] as WildsEntityKind, cx, cy, index };
}

function lootTableId(entity: WildsEntity): string {
  switch (entity.kind) {
    case 'camp':
      return 'camp';
    case 'node':
      return `node:${entity.material}`;
    case 'chest':
      return `chest:${entity.tier}`;
    default:
      return 'poi';
  }
}

export function chunkEntities(epoch: Epoch, cx: number, cy: number): WildsEntity[] {
  const data = loadWilds();
  const region = regionFor(data, epoch.regionId);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy)) throw new Error('wilds: chunk coords must be integers');
  const rng = new Rng(chunkSeed(epoch as SeedEpoch, cx, cy));
  const exits = buildExits(data, region, cx, cy);
  const occupied: Tile[] = [];
  const out: WildsEntity[] = [];
  for (const rule of data.entityKinds) {
    const count = rule.min + rng.nextInt(rule.max - rule.min + 1);
    for (let i = 0; i < count; i++) {
      const tile = placeEntity(rng, data, exits, occupied);
      occupied.push(tile);
      const id = `${rule.kind}:${cx}:${cy}:${i}`;
      const base: WildsEntity = { id, kind: rule.kind, tx: tile.tx, ty: tile.ty, enemies: [], material: '', tier: 0, poi: '' };
      switch (rule.kind) {
        case 'camp':
          out.push({ ...base, enemies: [...data.campMixes[rng.nextInt(data.campMixes.length)]] });
          break;
        case 'node':
          out.push({ ...base, material: data.materials[rng.nextInt(data.materials.length)] });
          break;
        case 'chest':
          out.push({ ...base, tier: 1 + rng.nextInt(3) });
          break;
        default:
          out.push({ ...base, poi: data.poiIds[rng.nextInt(data.poiIds.length)] });
      }
    }
  }
  return out;
}

export function rollLoot(epoch: Epoch, entityId: string, cycle: number): LootDrop {
  const data = loadWilds();
  if (!Number.isSafeInteger(cycle) || cycle < 0) throw new Error('wilds: cycle must be a non-negative integer');
  const parsed = parseEntityId(entityId);
  const entity = chunkEntities(epoch, parsed.cx, parsed.cy).find((e) => e.id === entityId);
  if (!entity) throw new Error(`wilds: unknown entity ${entityId}`);
  const table = data.lootTables[lootTableId(entity)];
  if (!table) throw new Error(`wilds: missing loot table ${lootTableId(entity)}`);
  const rng = new Rng(lootSeed(epoch as SeedEpoch, entityId, cycle));
  const materials: MaterialQty[] = [];
  for (const entry of table) {
    const chance = rng.nextInt(1000);
    const qty = entry.min + rng.nextInt(entry.max - entry.min + 1);
    if (chance < entry.chancePermille) materials.push({ id: entry.material, qty });
  }
  const trinketChance = rng.nextInt(1000);
  let trinket: string | null = null;
  if (trinketChance < data.trinketChancePermille) trinket = data.trinkets[rng.nextInt(data.trinkets.length)];
  return { materials, trinket };
}

// ---------------------------------------------------------------- terrain

/** Client-only terrain for one chunk: the Tangle's woods (tangle.ts).
 *  Deterministic (mulberry32 floats are fine here), and keeps every entity
 *  and exit reachable by construction plus a final carve pass. */
export function chunkTerrain(epoch: Epoch, cx: number, cy: number): ChunkTerrain {
  const data = loadWilds();
  const region = regionFor(data, epoch.regionId);
  const S = data.chunkSize;
  const seed = chunkSeed(epoch as SeedEpoch, cx, cy);
  // The generator's exits (they shaped entity placement), the way home over
  // the crossing for the outer region, plus the crossing itself on the
  // Tangle's far side — client-only, after entities are placed.
  const crossing = crossingExit(region.id, cx, cy);
  const exits = [...buildExits(data, region, cx, cy).map((e) => routeHome(region.id, e)), ...(crossing ? [crossing] : [])];
  const entities = chunkEntities(epoch, cx, cy);
  const spawn = spawnTile(data, exits);
  const outer = region.kind === 'outer';
  // Turncaps lean toward a light that held: in the Tangle, home (the Commons
  // gap on the entry chunk); past the crossing, east, toward Sallow Ford.
  const home = outer
    ? { tx: 100 * S, ty: 0 }
    : { tx: (region.entryX - cx) * S + COMMONS_EXIT_TX + 1, ty: (region.entryY - cy) * S + S - 1 };
  const sites = chunkSites(epoch, cx, cy, exits);
  const look = outer ? 'outer' : 'tangle';
  const { ground, solid, decor } = tangleTerrain({ size: S, rng: mulberry32(seed), seed, exits, entities, spawn, home, sites, look });

  // Safety pass: guarantee every exit mouth and entity is reachable from
  // spawn even if a placement rule above ever slips. Clears an L-path.
  const walkable = (tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < S && ty < S && !solid[ty][tx];
  const reachSet = (): Set<string> => {
    const seen = new Set<string>([tileKey(spawn.tx, spawn.ty)]);
    const queue: Tile[] = [spawn];
    while (queue.length) {
      const t = queue.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = t.tx + dx;
        const ny = t.ty + dy;
        if (!walkable(nx, ny) || seen.has(tileKey(nx, ny))) continue;
        seen.add(tileKey(nx, ny));
        queue.push({ tx: nx, ty: ny });
      }
    }
    return seen;
  };
  const targets: Tile[] = [];
  for (const e of exits) for (let y = e.ty; y < e.ty + e.th; y++) for (let x = e.tx; x < e.tx + e.tw; x++) targets.push({ tx: x, ty: y });
  for (const en of entities) targets.push({ tx: en.tx, ty: en.ty });
  for (const s of sites) targets.push({ tx: s.tx, ty: s.ty });
  for (let guard = 0; guard < targets.length + 2; guard++) {
    const reach = reachSet();
    const stuck = targets.find((t) => !reach.has(tileKey(t.tx, t.ty)));
    if (!stuck) break;
    const carve = (tx: number, ty: number) => {
      solid[ty][tx] = false;
      ground[ty][tx] = TANGLE_GROUND.path;
      for (let i = decor.length - 1; i >= 0; i--) {
        const d = decor[i];
        if (d.tx === tx && d.ty === ty && DECOR_ART[d.kind].blocking) decor.splice(i, 1);
      }
    };
    const stepX = Math.sign(stuck.tx - spawn.tx);
    for (let x = spawn.tx; x !== stuck.tx + stepX; x += stepX) carve(x, spawn.ty);
    const stepY = Math.sign(stuck.ty - spawn.ty);
    for (let y = spawn.ty; y !== stuck.ty + stepY; y += stepY) carve(stuck.tx, y);
    carve(stuck.tx, stuck.ty);
  }

  return {
    regionId: region.id,
    cx,
    cy,
    width: S,
    height: S,
    widthPx: S * TILE,
    heightPx: S * TILE,
    ground,
    solid,
    trees: [],
    bushes: [],
    rocks: [],
    decor,
    exits,
    spawn,
    sites,
    look,
    mark: outer ? seasonMark(epoch.season) : null,
  };
}

export const genV1: WildsGenerator = {
  version: 1,
  chunkEntities,
  rollLoot,
  chunkTerrain,
};
