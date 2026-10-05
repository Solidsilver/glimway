/**
 * The Tangle's terrain: dense iron-oak woods with winding, uneven paths.
 * Client-only and deterministic from the chunk seed (floats are fine here;
 * nothing in this file is server-reproduced).
 *
 * Layout, in order:
 *   1. Exit throats (a 3-wide mouth, three tiles deep), the spawn, and a
 *      clearing around every entity — wider for camps and points of
 *      interest, trodden bare around a camp's fire.
 *   2. Paths: from a jittered hub, each exit and then each entity is routed
 *      to the nearest path already laid (Dijkstra over a noisy cost field,
 *      so they wind and join into forks). Trunks to exits are 2–3 wide,
 *      branches to entities 2 wide.
 *   3. Side glades off the paths (a tight-ringed iron-oak stump, a dead
 *      birch carrying turncaps, a mossy boulder, a ring of turncaps).
 *   4. Drift cues: a spur path that runs into the woods and ends at a tree,
 *      and a stretch of the old road that crosses the paths and is
 *      swallowed by the trees on either side.
 *   5. Everything still unopened is woods (solid). Woods tiles carry trees,
 *      thickets, stumps, logs and boulders; cairns stand beside forks; the
 *      path edges get ferns, grass and turncaps (which lean toward home —
 *      the Commons — the way a turncap leans toward a light that held).
 *
 * Readability rules: entities keep a decor-free 3×3, exit throats and the
 * spawn stay bare, paths are never narrower than two tiles except spurs,
 * and any blocking piece whose art overhangs a walkable tile is flagged
 * `overhang` so it fades when someone walks beneath it.
 */
import { TERRAIN } from '../../game/textures.ts';
import type { ChunkExit, DecorKind, DecorSpot, Tile, WildsEntity } from './types.ts';

/** Ground ids the Tangle paints with (the ground art reads them back). */
export const TANGLE_GROUND = {
  /** Under the trees: dark loam, moss and leaf litter. */
  woods: TERRAIN.grass_b,
  /** Walkable moss in clearings and glades. */
  moss: TERRAIN.grass_a,
  /** The trodden line of a path. */
  path: TERRAIN.path_a,
  /** Walkable verge beside a path's trodden line (moss, worn at the middle). */
  verge: TERRAIN.path_b,
  /** Bare, trodden earth around camps. */
  trodden: TERRAIN.dirt,
  /** Broken cobbles of the old road. */
  road: TERRAIN.cobble_moss,
} as const;

const GROUND_RANK: Record<number, number> = {
  [TANGLE_GROUND.woods]: 0,
  [TANGLE_GROUND.moss]: 1,
  [TANGLE_GROUND.verge]: 1.5,
  [TANGLE_GROUND.path]: 2,
  [TANGLE_GROUND.trodden]: 3,
  [TANGLE_GROUND.road]: 4,
};

/**
 * Art footprint per decor kind, in px: width centred on the anchor and
 * height above it. The art draws inside it; the generator uses it to tell
 * which pieces overhang a walkable tile. `blocking` pieces only ever stand
 * on solid tiles; `flat` ones are ground decals drawn under everything.
 */
export const DECOR_ART: Record<DecorKind, { w: number; h: number; blocking: boolean; flat: boolean }> = {
  oak: { w: 30, h: 32, blocking: true, flat: false },
  pine: { w: 22, h: 36, blocking: true, flat: false },
  birch: { w: 22, h: 32, blocking: true, flat: false },
  'iron-oak': { w: 40, h: 42, blocking: true, flat: false },
  snag: { w: 18, h: 28, blocking: true, flat: false },
  thicket: { w: 24, h: 18, blocking: true, flat: false },
  stump: { w: 18, h: 14, blocking: true, flat: false },
  'ring-stump': { w: 22, h: 14, blocking: true, flat: false },
  log: { w: 32, h: 13, blocking: true, flat: false },
  boulder: { w: 20, h: 15, blocking: true, flat: false },
  cairn: { w: 14, h: 21, blocking: true, flat: false },
  fern: { w: 15, h: 11, blocking: false, flat: false },
  grass: { w: 11, h: 9, blocking: false, flat: false },
  flowers: { w: 11, h: 7, blocking: false, flat: false },
  turncaps: { w: 13, h: 9, blocking: false, flat: false },
  roots: { w: 16, h: 12, blocking: false, flat: true },
  litter: { w: 14, h: 9, blocking: false, flat: true },
  pebbles: { w: 11, h: 7, blocking: false, flat: true },
};

export interface TangleInput {
  size: number;
  /** Float PRNG (0..1) seeded from the chunk seed. */
  rng: () => number;
  /** Seed for the smooth noise fields. */
  seed: number;
  exits: readonly ChunkExit[];
  entities: readonly WildsEntity[];
  spawn: Tile;
  /** Home (the Commons gap) in chunk-local tiles; may lie outside the chunk. */
  home: Tile;
}

export interface TangleTerrain {
  ground: number[][];
  solid: boolean[][];
  decor: DecorSpot[];
}

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const key = (x: number, y: number) => `${x},${y}`;

/** Smooth 2D value noise in 0..1 (one octave, smoothstep-interpolated). */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (x: number, y: number): number => {
    let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = lattice(x0, y0) + (lattice(x0 + 1, y0) - lattice(x0, y0)) * sx;
    const b = lattice(x0, y0 + 1) + (lattice(x0 + 1, y0 + 1) - lattice(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/** Binary min-heap of [cost, index] for the path router. */
class Heap {
  private items: [number, number][] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: [number, number]): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function tangleTerrain(input: TangleInput): TangleTerrain {
  const { size: S, rng, exits, entities, spawn, home } = input;
  const wind = valueNoise(input.seed);
  const jag = valueNoise(input.seed ^ 0x5bd1e995);
  const brush = valueNoise(input.seed ^ 0x2545f491);

  const walk: boolean[][] = Array.from({ length: S }, () => Array.from({ length: S }, () => false));
  const ground: number[][] = Array.from({ length: S }, () => Array.from({ length: S }, () => TANGLE_GROUND.woods));
  /** Tiles decor leaves bare: entity surrounds, exit throats, the spawn. */
  const bare = new Set<string>();
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S;
  const interior = (x: number, y: number) => x >= 1 && y >= 1 && x <= S - 2 && y <= S - 2;
  const exitTile = (x: number, y: number) => exits.some((e) => x >= e.tx && x < e.tx + e.tw && y >= e.ty && y < e.ty + e.th);
  const openable = (x: number, y: number) => interior(x, y) || exitTile(x, y);
  const carve = (x: number, y: number, g: number): void => {
    if (!openable(x, y)) return;
    walk[y][x] = true;
    if (GROUND_RANK[g] > GROUND_RANK[ground[y][x]]) ground[y][x] = g;
  };
  const isWalk = (x: number, y: number) => inBounds(x, y) && walk[y][x];

  // ---------------------------------------------------------- 1. fixed openings

  /** Where each exit's throat meets the woods (route anchors). */
  const throats: Tile[] = [];
  for (const e of exits) {
    const horiz = e.dir === 'north' || e.dir === 'south';
    for (let d = 0; d < 3; d++) {
      for (let k = 0; k < 3; k++) {
        const x = horiz ? e.tx + k : e.dir === 'west' ? d : S - 1 - d;
        const y = horiz ? (e.dir === 'north' ? d : S - 1 - d) : e.ty + k;
        carve(x, y, k === 1 ? TANGLE_GROUND.path : TANGLE_GROUND.verge);
        bare.add(key(x, y));
      }
    }
    throats.push(
      e.dir === 'north' ? { tx: e.tx + 1, ty: 2 } :
      e.dir === 'south' ? { tx: e.tx + 1, ty: S - 3 } :
      e.dir === 'west' ? { tx: 2, ty: e.ty + 1 } :
      { tx: S - 3, ty: e.ty + 1 }
    );
  }
  for (let y = spawn.ty - 1; y <= spawn.ty + 1; y++) {
    for (let x = spawn.tx - 1; x <= spawn.tx + 1; x++) {
      carve(x, y, x === spawn.tx ? TANGLE_GROUND.path : TANGLE_GROUND.verge);
      bare.add(key(x, y));
    }
  }

  // Entity clearings: a guaranteed core (3×3; camps and points of interest
  // 5×5) inside a ragged blob.
  for (const en of entities) {
    const camp = en.kind === 'camp';
    const radius = camp ? 2.8 : en.kind === 'poi' ? 2.4 : 1.9;
    const core = camp || en.kind === 'poi' ? 2 : 1;
    const reach = Math.ceil(radius + 1);
    for (let y = en.ty - reach; y <= en.ty + reach; y++) {
      for (let x = en.tx - reach; x <= en.tx + reach; x++) {
        const cheb = Math.max(Math.abs(x - en.tx), Math.abs(y - en.ty));
        const d = Math.hypot(x - en.tx, y - en.ty) + (jag(x * 0.8, y * 0.8) - 0.5) * 1.6;
        if (cheb <= core || d <= radius) carve(x, y, camp && cheb <= 1 + (d < 2 ? 1 : 0) ? TANGLE_GROUND.trodden : TANGLE_GROUND.moss);
      }
    }
    // The camp's fire sits a tile west of its pack.
    for (let y = en.ty - 1; y <= en.ty + 1; y++) for (let x = en.tx - (camp ? 2 : 1); x <= en.tx + 1; x++) bare.add(key(x, y));
  }

  // ---------------------------------------------------------- 2. paths

  const clampHub = (v: number) => Math.max(5, Math.min(S - 6, Math.round(v)));
  const hub: Tile = { tx: clampHub(S / 2 - 0.5 + (rng() - 0.5) * 7), ty: clampHub(S / 2 - 0.5 + (rng() - 0.5) * 7) };
  const network = new Set<string>();
  for (const [dx, dy] of [[0, 0], ...DIRS]) {
    carve(hub.tx + dx, hub.ty + dy, dx === 0 && dy === 0 ? TANGLE_GROUND.path : TANGLE_GROUND.verge);
    network.add(key(hub.tx + dx, hub.ty + dy));
  }
  const forks: Tile[] = [hub];
  /** Every tile a route's centre line passed (spurs and glades branch off these). */
  const coreTiles: Tile[] = [];

  const stepCost = (x: number, y: number): number => {
    if (!openable(x, y)) return Infinity;
    if (walk[y][x]) return 0.7;
    const n = wind(x / 3.6, y / 3.6);
    let c = 1 + 9 * n * n;
    if (x === 1 || y === 1 || x === S - 2 || y === S - 2) c += 4;
    return c;
  };

  /** Cheapest way from `from` to any goal tile (default: the network). */
  const route = (from: Tile, goal: (x: number, y: number) => boolean = (x, y) => network.has(key(x, y))): Tile[] => {
    if (goal(from.tx, from.ty)) return [from];
    const dist = new Float64Array(S * S).fill(Infinity);
    const prev = new Int32Array(S * S).fill(-1);
    const heap = new Heap();
    const start = from.ty * S + from.tx;
    dist[start] = 0;
    heap.push([0, start]);
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      const x = i % S;
      const y = (i - x) / S;
      if (goal(x, y)) {
        const out: Tile[] = [];
        for (let j = i; j !== -1; j = prev[j]) out.push({ tx: j % S, ty: Math.floor(j / S) });
        return out.reverse();
      }
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const nd = d + stepCost(nx, ny);
        const ni = ny * S + nx;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          prev[ni] = i;
          heap.push([nd, ni]);
        }
      }
    }
    return [from];
  };

  const lay = (from: Tile, trunk: boolean): void => {
    let line = route(from);
    // Trunks bend: detour through a point pushed off the straight line.
    if (trunk && line.length > 6) {
      const mid = line[Math.floor(line.length * (0.35 + rng() * 0.3))];
      const join0 = line[line.length - 1];
      const ax = join0.tx - from.tx;
      const ay = join0.ty - from.ty;
      const len = Math.hypot(ax, ay) || 1;
      const push = (rng() < 0.5 ? -1 : 1) * (3 + rng() * 2.5);
      const w = { tx: Math.round(mid.tx - (ay / len) * push), ty: Math.round(mid.ty + (ax / len) * push) };
      w.tx = Math.max(2, Math.min(S - 3, w.tx));
      w.ty = Math.max(2, Math.min(S - 3, w.ty));
      const first = route(from, (x, y) => x === w.tx && y === w.ty);
      line = [...first.slice(0, -1), ...route(w)];
    }
    const join = line[line.length - 1];
    if (line.length > 2) forks.push(join);
    for (const t of line) {
      network.add(key(t.tx, t.ty));
      coreTiles.push(t);
      // An uneven brush: 2×2 nudged by noise, widening to 3×3 along trunks.
      const n = brush(t.tx * 0.7, t.ty * 0.7);
      const wide = trunk && n > 0.45;
      const x0 = wide ? t.tx - 1 : t.tx - (brush(t.tx * 1.3 + 9, t.ty * 1.3) < 0.5 ? 1 : 0);
      const y0 = wide ? t.ty - 1 : t.ty - (brush(t.tx * 1.3, t.ty * 1.3 + 9) < 0.5 ? 1 : 0);
      const span = wide ? 3 : 2;
      for (let y = y0; y < y0 + span; y++) for (let x = x0; x < x0 + span; x++) carve(x, y, TANGLE_GROUND.verge);
      carve(t.tx, t.ty, TANGLE_GROUND.path);
    }
  };

  const byHub = (a: Tile, b: Tile) => Math.hypot(a.tx - hub.tx, a.ty - hub.ty) - Math.hypot(b.tx - hub.tx, b.ty - hub.ty);
  for (const t of [...throats].sort(byHub)) lay(t, true);
  for (const en of [...entities].sort(byHub)) lay({ tx: en.tx, ty: en.ty }, false);

  const nearEntity = (x: number, y: number, r: number) => entities.some((en) => Math.abs(en.tx - x) <= r && Math.abs(en.ty - y) <= r);
  const nearThroat = (x: number, y: number, r: number) => throats.some((t) => Math.abs(t.tx - x) <= r && Math.abs(t.ty - y) <= r);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];

  // ---------------------------------------------------------- 3. side glades

  /** Special blocking pieces placed before the general woods pass. */
  const special = new Map<string, DecorSpot>();
  const spot = (kind: DecorKind, tx: number, ty: number, ox = 0, oy = 0, flip = false): DecorSpot => ({
    kind,
    tx,
    ty,
    ox,
    oy,
    variant: Math.floor(rng() * 8),
    flip,
    overhang: false,
  });
  const leanHome = (tx: number) => home.tx > tx;
  const undergrowth: DecorSpot[] = [];
  const features: ('ring-stump' | 'snag' | 'boulder' | 'turncaps')[] = ['ring-stump', 'snag', 'boulder', 'turncaps'];
  const glades = 1 + (rng() < 0.6 ? 1 : 0);
  let ringStumps = 0;
  for (let g = 0, tries = 0; g < glades && tries < 60; tries++) {
    if (!coreTiles.length) break;
    const c = pick(coreTiles);
    const [dx, dy] = pick(DIRS);
    const center = { tx: c.tx + dx * 3, ty: c.ty + dy * 3 };
    if (center.tx < 2 || center.ty < 2 || center.tx > S - 3 || center.ty > S - 3) continue;
    let fresh = true;
    for (let y = center.ty - 1; y <= center.ty + 1 && fresh; y++) for (let x = center.tx - 1; x <= center.tx + 1 && fresh; x++) if (walk[y][x]) fresh = false;
    if (!fresh || nearEntity(center.tx, center.ty, 3) || nearThroat(center.tx, center.ty, 3)) continue;
    // The way in, then the ragged ring around the glade's centre.
    carve(c.tx + dx, c.ty + dy, TANGLE_GROUND.moss);
    carve(c.tx + dx * 2, c.ty + dy * 2, TANGLE_GROUND.moss);
    for (let y = center.ty - 2; y <= center.ty + 2; y++) {
      for (let x = center.tx - 2; x <= center.tx + 2; x++) {
        const cheb = Math.max(Math.abs(x - center.tx), Math.abs(y - center.ty));
        if (cheb <= 1 || Math.hypot(x - center.tx, y - center.ty) + (jag(x * 0.9 + 3, y * 0.9) - 0.5) * 1.4 <= 1.9) carve(x, y, TANGLE_GROUND.moss);
      }
    }
    let feature = pick(features);
    if (feature === 'ring-stump' && ringStumps > 0) feature = 'boulder';
    if (feature === 'turncaps') {
      // A ring of caps on open moss, all leaning the same way.
      for (const [rx, ry] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
        undergrowth.push(spot('turncaps', center.tx + rx, center.ty + ry, Math.round((rng() - 0.5) * 4), -Math.round(rng() * 3), leanHome(center.tx + rx)));
      }
    } else {
      walk[center.ty][center.tx] = false;
      special.set(key(center.tx, center.ty), spot(feature, center.tx, center.ty, 0, -1));
      if (feature === 'ring-stump') ringStumps++;
      // Turncaps gather on the dead wood.
      if (feature !== 'boulder') {
        for (const [rx, ry] of [[1, 0], [-1, 1]]) undergrowth.push(spot('turncaps', center.tx + rx, center.ty + ry, -rx * 4, -2, leanHome(center.tx + rx)));
      }
    }
    for (let y = center.ty - 1; y <= center.ty + 1; y++) for (let x = center.tx - 1; x <= center.tx + 1; x++) bare.add(key(x, y));
    g++;
  }

  // ---------------------------------------------------------- 4. drift cues

  // A spur: a path into the woods that ends at a tree standing on it.
  if (rng() < 0.8) {
    for (let tries = 0; tries < 80; tries++) {
      const c = pick(coreTiles);
      const [dx, dy] = pick(DIRS);
      const len = 3 + Math.floor(rng() * 3);
      const end = { tx: c.tx + dx * (len + 1), ty: c.ty + dy * (len + 1) };
      if (!interior(end.tx, end.ty) || nearEntity(c.tx, c.ty, 3) || nearThroat(c.tx, c.ty, 3)) continue;
      let ok = true;
      for (let k = 1; k <= len + 1 && ok; k++) {
        const x = c.tx + dx * k;
        const y = c.ty + dy * k;
        if (!interior(x, y) || (k > 1 && walk[y][x])) ok = false;
        // Woods on both sides past the first step, so it reads as its own lane.
        if (ok && k > 1 && (isWalk(x + dy, y + dx) || isWalk(x - dy, y - dx))) ok = false;
        if (ok && nearEntity(x, y, 2)) ok = false;
      }
      if (!ok) continue;
      for (let k = 1; k <= len; k++) carve(c.tx + dx * k, c.ty + dy * k, TANGLE_GROUND.path);
      // The path runs on under the tree (and a tile beyond, into the woods).
      ground[end.ty][end.tx] = TANGLE_GROUND.path;
      if (interior(end.tx + dx, end.ty + dy) && !walk[end.ty + dy][end.tx + dx]) ground[end.ty + dy][end.tx + dx] = TANGLE_GROUND.path;
      special.set(key(end.tx, end.ty), spot(rng() < 0.5 ? 'iron-oak' : 'oak', end.tx, end.ty, 0, -1));
      break;
    }
  }

  // The old road: a straight two-wide run of cobbles, cut off by the woods.
  if (rng() < 0.6) {
    for (let tries = 0; tries < 40; tries++) {
      const horiz = rng() < 0.5;
      const len = 6 + Math.floor(rng() * 5);
      const along0 = 1 + Math.floor(rng() * (S - len - 2));
      const across = 3 + Math.floor(rng() * (S - 7));
      const tiles: Tile[] = [];
      for (let a = along0; a < along0 + len; a++) for (let b = across; b < across + 2; b++) tiles.push(horiz ? { tx: a, ty: b } : { tx: b, ty: a });
      if (!tiles.some((t) => walk[t.ty][t.tx]) || !tiles.some((t) => !walk[t.ty][t.tx])) continue;
      if (tiles.some((t) => bare.has(key(t.tx, t.ty)) || special.has(key(t.tx, t.ty)))) continue;
      for (const t of tiles) ground[t.ty][t.tx] = TANGLE_GROUND.road;
      break;
    }
  }

  // ---------------------------------------------------------- 5. dressing

  const solid: boolean[][] = walk.map((row) => row.map((w) => !w));
  const decor: DecorSpot[] = [];
  const taken = new Set<string>();
  const art = (k: DecorKind) => DECOR_ART[k];
  const overhangs = (d: DecorSpot): boolean => {
    const a = art(d.kind);
    const x0 = d.tx * 16 + 8 + d.ox - a.w / 2;
    const y1 = (d.ty + 1) * 16 + d.oy;
    const y0 = y1 - a.h;
    for (let ty = Math.floor(y0 / 16); ty <= Math.floor((y1 - 1) / 16); ty++) {
      for (let tx = Math.floor(x0 / 16); tx <= Math.floor((x0 + a.w - 1) / 16); tx++) {
        if (!isWalk(tx, ty)) continue;
        // Ignore slivers: the art must reach 3 px into the walkable tile.
        const ix = Math.min(x0 + a.w, tx * 16 + 16) - Math.max(x0, tx * 16);
        const iy = Math.min(y1, ty * 16 + 16) - Math.max(y0, ty * 16);
        if (ix >= 3 && iy >= 3) return true;
      }
    }
    return false;
  };
  const place = (d: DecorSpot): void => {
    d.overhang = art(d.kind).blocking && overhangs(d);
    decor.push(d);
  };

  // Cairns beside forks: on a woods tile that faces the path.
  const faces = (x: number, y: number) => DIRS.some(([dx, dy]) => isWalk(x + dx, y + dy));
  /** Any walkable tile in the 3×3 around (x, y). */
  const nearWalk = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isWalk(x + dx, y + dy)) return true;
    return false;
  };
  let cairns = 0;
  for (const f of forks) {
    if (cairns >= 2) break;
    if (nearThroat(f.tx, f.ty, 2) || nearEntity(f.tx, f.ty, 1)) continue;
    let best: Tile | null = null;
    let bestD = Infinity;
    for (let y = f.ty - 2; y <= f.ty + 2; y++) {
      for (let x = f.tx - 2; x <= f.tx + 2; x++) {
        if (!interior(x, y) || walk[y][x] || special.has(key(x, y)) || !faces(x, y)) continue;
        const d = Math.hypot(x - f.tx, y - f.ty) + rng() * 0.3;
        if (d < bestD) {
          bestD = d;
          best = { tx: x, ty: y };
        }
      }
    }
    if (!best) continue;
    special.set(key(best.tx, best.ty), spot('cairn', best.tx, best.ty, 0, -1));
    cairns++;
  }

  for (const d of special.values()) {
    place(d);
    taken.add(key(d.tx, d.ty));
  }

  // Fallen logs: two woods tiles side by side, facing the path.
  let logs = 0;
  for (let y = 1; y < S - 1 && logs < 2; y++) {
    for (let x = 1; x < S - 2 && logs < 2; x++) {
      if (walk[y][x] || walk[y][x + 1] || taken.has(key(x, y)) || taken.has(key(x + 1, y))) continue;
      if (!(isWalk(x, y + 1) && isWalk(x + 1, y + 1)) && !(isWalk(x, y - 1) && isWalk(x + 1, y - 1))) continue;
      if (rng() > 0.1) continue;
      place(spot('log', x, y, 8, -1, rng() < 0.5));
      taken.add(key(x, y));
      taken.add(key(x + 1, y));
      logs++;
    }
  }

  const tree = (x: number, y: number, edge: boolean, underPath: boolean): DecorSpot => {
    const r = rng();
    const ox = Math.round((rng() - 0.5) * (edge ? 4 : 8));
    const oy = underPath ? Math.round(rng() * 2) : -Math.round(rng() * (edge ? 2 : 4));
    if (r < 0.14 && !edge) {
      const big = spot('iron-oak', x, y, ox, oy, rng() < 0.5);
      if (!overhangs(big)) return big;
    }
    const kind: DecorKind = r < 0.36 ? 'pine' : r < 0.43 ? 'birch' : 'oak';
    return spot(kind, x, y, ox, oy, rng() < 0.5);
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (walk[y][x] || taken.has(key(x, y))) continue;
      const edge = faces(x, y);
      // Woods right below a path: keep the canopy off the path where we can.
      const underPath = isWalk(x, y - 1);
      const r = rng();
      if (edge) {
        if (r < (underPath ? 0.3 : 0.1)) place(spot('thicket', x, y, Math.round((rng() - 0.5) * 4), 0, rng() < 0.5));
        else if (r < (underPath ? 0.36 : 0.14)) place(spot('boulder', x, y, Math.round((rng() - 0.5) * 4), -1, rng() < 0.5));
        else if (r < (underPath ? 0.42 : 0.18)) place(spot('stump', x, y, Math.round((rng() - 0.5) * 4), -2, rng() < 0.5));
        else place(tree(x, y, true, underPath));
        // Undergrowth at the foot of the woods, in front of the trunks.
        if (isWalk(x, y + 1) && !bare.has(key(x, y + 1)) && rng() < 0.45) {
          undergrowth.push(spot(rng() < 0.6 ? 'fern' : 'grass', x, y, Math.round((rng() - 0.5) * 8), 2, rng() < 0.5));
        }
      } else if (r < 0.08) place(spot('thicket', x, y, Math.round((rng() - 0.5) * 6), -Math.round(rng() * 3), rng() < 0.5));
      else if (r < 0.13) place(spot('fern', x, y, Math.round((rng() - 0.5) * 6), -Math.round(rng() * 4), rng() < 0.5));
      // Deep in the woods the crowns close overhead on their own: thinner
      // planting keeps the canopy whole with fewer sprites.
      else if (r < 0.38 && !nearWalk(x, y)) continue
      else place(tree(x, y, false, false));
      taken.add(key(x, y));
    }
  }

  // Walk-through undergrowth along the edges; decals on the open ground.
  const rooted = new Set(decor.filter((d) => d.kind === 'oak' || d.kind === 'iron-oak').map((d) => key(d.tx, d.ty)));
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      if (!walk[y][x] || bare.has(key(x, y))) continue;
      const woodsDirs = DIRS.filter(([dx, dy]) => !isWalk(x + dx, y + dy));
      const r = rng();
      if (woodsDirs.length) {
        const [dx, dy] = pick(woodsDirs);
        const ox = dx * 5 + Math.round((rng() - 0.5) * 3);
        const oy = dy < 0 ? -7 : dy > 0 ? 1 : -Math.round(rng() * 4);
        if (r < 0.38) undergrowth.push(spot('fern', x, y, ox, oy, rng() < 0.5));
        else if (r < 0.56) undergrowth.push(spot('grass', x, y, ox, oy, rng() < 0.5));
        else if (r < 0.62) undergrowth.push(spot('turncaps', x, y, ox, oy, leanHome(x)));
        else if (r < 0.66) undergrowth.push(spot('flowers', x, y, ox, oy, rng() < 0.5));
        // A second tuft against another side now and then.
        if (woodsDirs.length > 1 && rng() < 0.3) {
          const [ex, ey] = woodsDirs.find(([wx, wy]) => wx !== dx || wy !== dy)!;
          undergrowth.push(spot(rng() < 0.5 ? 'fern' : 'grass', x, y, ex * 5, ey < 0 ? -7 : ey > 0 ? 1 : -2, rng() < 0.5));
        }
        // Roots crossing the path from an oak beside it.
        const root = DIRS.find(([rx, ry]) => rooted.has(key(x + rx, y + ry)));
        if (root && rng() < 0.35) undergrowth.push(spot('roots', x, y, root[0] * 3, root[1] < 0 ? -2 : 0, root[0] > 0));
      } else if (ground[y][x] === TANGLE_GROUND.path || ground[y][x] === TANGLE_GROUND.verge || ground[y][x] === TANGLE_GROUND.road) {
        if (r < 0.06) undergrowth.push(spot('pebbles', x, y, Math.round((rng() - 0.5) * 8), -Math.round(rng() * 8), rng() < 0.5));
        else if (r < 0.14) undergrowth.push(spot('litter', x, y, Math.round((rng() - 0.5) * 8), -Math.round(rng() * 8), rng() < 0.5));
      } else if (r < 0.14) undergrowth.push(spot('grass', x, y, Math.round((rng() - 0.5) * 8), -Math.round(rng() * 6), rng() < 0.5));
      else if (r < 0.21) undergrowth.push(spot('flowers', x, y, Math.round((rng() - 0.5) * 8), -Math.round(rng() * 6), rng() < 0.5));
      else if (r < 0.26) undergrowth.push(spot('litter', x, y, Math.round((rng() - 0.5) * 8), -Math.round(rng() * 6), rng() < 0.5));
    }
  }
  for (const d of undergrowth) place(d);

  decor.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  return { ground, solid, decor };
}
