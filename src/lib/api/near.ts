/**
 * The near read's checks (open-map.md 2.4): what the facade refuses before a
 * WildsNearResult reaches the game. Everything a client later indexes by
 * (chunk keys, local tiles, epochs, way paths) is held to the contract here.
 */
import type { WildsChunkKey, WildsNearResult, WorldTile } from '../gen/glimway/v1/wilds_pb.js';
import { loadWilds } from '../wilds/data.ts';
import { epochKindAt } from '../wilds/coords.ts';
import { onGrid } from '../location.ts';

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
  const inFrontier = (k: { cx: number; cy: number }) => k.cx >= f.minCx && k.cx <= f.maxCx && k.cy >= f.minCy && k.cy <= f.maxCy;
  // A centre on the grid: inside the frontier, or on a fixed footprint (the Commons: location-seam.md 1.4).
  if (!inFrontier(c) && !onGrid(c.cx, c.cy)) throw new Error('invalid near window');
  const keyed = (k: WildsChunkKey | undefined): k is WildsChunkKey => !!k && k.realm === w.realm && k.layer === 0;
  const inWindow = (k: WildsChunkKey) => Math.abs(k.cx - cx) <= NEAR_RADIUS && Math.abs(k.cy - cy) <= NEAR_RADIUS;
  // A chunk's epoch follows from its coordinates: the still epoch inside a
  // still footprint (the Tangle), else the wick's.
  const epochOf = (k: { cx: number; cy: number }) => (epochKindAt(k.cx, k.cy) === 'still' ? out.still!.id : out.wick!.id);
  const epochs = [out.still.id, out.wick.id];

  for (const e of out.entities) {
    if (!e.id || !epochs.includes(e.epoch) || !Number.isSafeInteger(e.cycle) || e.cycle < 0 || !ENTITY_STATES.includes(e.state)) throw new Error('invalid mutable entity');
  }

  const chunks = new Set<string>();
  for (const g of out.ground) {
    const k = g.chunk;
    if (!keyed(k) || !inWindow(k) || !inFrontier(k) || g.epoch !== epochOf(k)) throw new Error('invalid ground chunk');
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
