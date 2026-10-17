/**
 * The near read's checks (open-map.md 2.4): what the facade refuses before a
 * WildsNearResult reaches the game. Everything a client later indexes by
 * (chunk keys, local tiles, epochs, way paths) is held to the contract here.
 */
import type { WildsMapStatus, WildsChunkKey, WildsNearResult, WorldTile } from '../gen/glimway/v1/wilds_pb.js';
import { loadWilds } from '../wilds/data.ts';
import { epochKindAt, insideFrontier } from '../wilds/coords.ts';
import { onGrid, sourceOf } from '../location.ts';

/** The near read always answers the 5×5 chunks around the asked one. */
export const NEAR_RADIUS = 2;

const CHANGES = ['cleared', 'stone', 'plank'];
const ENTITY_STATES = ['available', 'cleared', 'harvested', 'charted'];

/** Throws on anything the near read's contract rules out; returns the result. */
export function validateNear(out: WildsNearResult, cx: number, cy: number): WildsNearResult {
  const w = loadWilds();
  const S = w.chunkSize;
  if (!out.still?.id || out.still.kind !== 'still' || !out.wick?.id || out.wick.kind !== 'wick' || out.still.id === out.wick.id) throw new Error('invalid epoch authority');
  const c = out.center;
  if (!c || c.realm !== w.realm || c.layer !== 0 || c.cx !== cx || c.cy !== cy || out.radius !== NEAR_RADIUS) throw new Error('invalid near window');
  const f = out.frontier?.rect;
  if (!f || f.minCx > f.maxCx || f.minCy > f.maxCy) throw new Error('invalid frontier');
  // Held chunks push the frontier out (lamps.md 2.2): this answer's own, not the last read's.
  const reach = out.frontier!.held;
  if (!reach.every((k) => k.realm === w.realm && k.layer === 0 && Number.isSafeInteger(k.cx) && Number.isSafeInteger(k.cy))) throw new Error('invalid frontier');
  const inFrontier = (k: { cx: number; cy: number }) => k.cx >= f.minCx && k.cx <= f.maxCx && k.cy >= f.minCy && k.cy <= f.maxCy && insideFrontier(k.cx, k.cy, undefined, reach);
  // A centre on the grid: inside the frontier, or on a fixed footprint (the Commons: location-seam.md 1.4).
  if (!inFrontier(c) && !onGrid(c.cx, c.cy)) throw new Error('invalid near window');
  const keyed = (k: WildsChunkKey | undefined): k is WildsChunkKey => !!k && k.realm === w.realm && k.layer === 0;
  const inWindow = (k: WildsChunkKey) => Math.abs(k.cx - cx) <= NEAR_RADIUS && Math.abs(k.cy - cy) <= NEAR_RADIUS;
  // Held chunks (roadmap 0.12) keep an older wick's land: each held epoch
  // is a wick epoch, named once, and only the window's held chunks use it.
  const held = out.held.map((e) => e.id);
  for (const e of out.held) {
    if (!e.id || e.kind !== 'wick' || e.id === out.still.id || e.id === out.wick.id || held.indexOf(e.id) !== held.lastIndexOf(e.id)) throw new Error('invalid epoch authority');
  }
  const heldAt = new Map<string, string>();
  for (const n of out.chunks) {
    const k = n.chunk;
    if (n.source !== 'held') continue;
    if (!keyed(k) || !inWindow(k) || !inFrontier(k) || sourceOf(k.cx, k.cy).kind !== 'generated' || epochKindAt(k.cx, k.cy) !== 'wick' || (n.epoch !== out.wick.id && !held.includes(n.epoch))) throw new Error('invalid held chunk');
    heldAt.set(`${k.cx}:${k.cy}`, n.epoch);
  }
  // A chunk's epoch follows from its coordinates: a held chunk's pinned
  // epoch, the still epoch inside a still footprint (the Tangle), else the
  // wick's.
  const epochOf = (k: { cx: number; cy: number }) => heldAt.get(`${k.cx}:${k.cy}`) ?? (epochKindAt(k.cx, k.cy) === 'still' ? out.still!.id : out.wick!.id);
  const epochs = [out.still.id, out.wick.id, ...held];

  for (const d of out.discoveries) if (!d.entityId || !epochs.includes(d.epoch)) throw new Error('invalid discovery');

  for (const e of out.entities) {
    if (!e.id || !epochs.includes(e.epoch) || !Number.isSafeInteger(e.cycle) || e.cycle < 0 || !ENTITY_STATES.includes(e.state)) throw new Error('invalid mutable entity');
  }

  const chunks = new Set<string>();
  for (const g of out.ground) {
    const k = g.chunk;
    if (!keyed(k) || !inWindow(k) || !inFrontier(k) || sourceOf(k.cx, k.cy).kind !== 'generated' || g.epoch !== epochOf(k)) throw new Error('invalid ground chunk');
    const id = `${k.cx}:${k.cy}`;
    if (chunks.has(id)) throw new Error('invalid ground chunk');
    chunks.add(id);
    const changes = g.changes?.changes ?? [];
    if (changes.length > w.paths.maxChanges) throw new Error('invalid ground changes');
    const tiles = new Set<number>();
    for (const ch of changes) {
      if (ch.tx >= S || ch.ty >= S || !CHANGES.includes(ch.change) || !ch.by || !Number.isFinite(ch.at)) throw new Error('invalid ground changes');
      const t = ch.ty * S + ch.tx;
      if (tiles.has(t)) throw new Error('invalid ground changes');
      tiles.add(t);
    }
  }

  // The glimpse is only ever past the frontier.
  for (const gl of out.glimpse) if (!keyed(gl.chunk) || inFrontier(gl.chunk) || !w.lands.some((l) => l.id === gl.land)) throw new Error('invalid glimpse');

  const adjacent = (a: WorldTile, b: WorldTile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  for (const way of out.ways) {
    const path = way.path;
    if (!way.a || !way.b || way.a >= way.b || way.id !== `way:${way.a}:${way.b}` || !way.name || !way.by || !epochs.includes(way.epoch) || !path.length) throw new Error('invalid way');
    for (let i = 1; i < path.length; i++) if (!adjacent(path[i - 1]!, path[i]!)) throw new Error('invalid way');
    const onPath = (t: WorldTile) => path.some((p) => p.x === t.x && p.y === t.y);
    const signs: [WorldTile | undefined, WorldTile][] = [[way.signA, path[0]!], [way.signB, path[path.length - 1]!]];
    for (const [sign, end] of signs) if (!sign || !adjacent(sign, end) || onPath(sign)) throw new Error('invalid way');
  }

  for (const qty of Object.values(out.materials)) if (!Number.isSafeInteger(qty) || qty < 0) throw new Error('invalid material balance');
  return out;
}

/** Refuse statuses outside the requested explored set. Own lot marks carry no terrain. */
export function validateMapStatus(out: WildsMapStatus, explored: readonly { cx: number; cy: number }[]): WildsMapStatus {
  if (!out.wick) throw new Error('invalid map wick');
  const keys = new Set(explored.map((k) => k.cx + ',' + k.cy));
  const seen = new Set<string>();
  const land = (s: WildsMapStatus['chunks'][number]) => {
    if (!s.chunk || s.chunk.realm !== loadWilds().realm || s.chunk.layer !== 0 || !['wild','common','built','still','permanent'].includes(s.tier) || !['held','dimming','turns','released','carries','paths-turn','lamps-carry','lamps-turn','detail-turns','permanent'].includes(s.nextTurning)) throw new Error('invalid land status');
    if (s.tier === 'built' && (!s.claimId || s.cost !== 1)) throw new Error('invalid built status');
    if (s.epoch && (!s.epoch.id || s.epoch.kind !== 'wick' || s.tier !== 'built')) throw new Error('invalid map epoch');
    if (s.ground) {
      if (s.tier !== 'common' || s.ground.changes.length > loadWilds().paths.maxChanges) throw new Error('invalid map ground');
      const tiles = new Set<number>();
      for (const t of s.ground.changes) {
        const key = t.ty * loadWilds().chunkSize + t.tx;
        if (t.tx >= loadWilds().chunkSize || t.ty >= loadWilds().chunkSize || !CHANGES.includes(t.change) || !t.by || !Number.isFinite(t.at) || tiles.has(key)) throw new Error('invalid map ground');
        tiles.add(key);
      }
    }
  };
  for (const s of out.chunks) {
    land(s);
    const key = s.chunk!.cx + ',' + s.chunk!.cy;
    if (!keys.has(key) || seen.has(key)) throw new Error('unexplored land status');
    seen.add(key);
  }
  const ids = new Set<string>();
  for (const l of out.lamps) {
    if (!l.id || ids.has(l.id) || !l.land || !['lot-lantern','way-lamp','common-lamp'].includes(l.kind) || !Number.isFinite(l.at)) throw new Error('invalid map lamp');
    ids.add(l.id); land(l.land);
    const k = l.land.chunk!;
    if (l.kind !== 'lot-lantern' && !keys.has(k.cx + ',' + k.cy)) throw new Error('unexplored map lamp');
  }
  return out;
}
