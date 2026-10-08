import { clone, fromBinary } from '@bufbuild/protobuf';
import { WildsChunkSchema, Dir, SiteKind, type WildsChunk, type WildsEntity } from '../gen/glimway/v1/wilds_pb.js';

export const CHUNK_SIZE = 24;
const destinationSize = (to: string): [number, number] => {
  if (/^chunk:(inner-1|outer-1):[0-2]:[0-2]$/.test(to)) return [24, 24];
  if (to === 'commons') return [62, 42];
  throw new Error('unknown destination');
};
export function validateChunk(chunk: WildsChunk): WildsChunk {
  const size = chunk.size;
  if (size !== CHUNK_SIZE || !chunk.epochId || !['inner-1', 'outer-1'].includes(chunk.region) || chunk.generatorVersion !== 2 || chunk.realm !== "hearthwick" || chunk.layer !== 0 || !["tangle", "outer"].includes(chunk.look) || chunk.cx < 0 || chunk.cx >= 3 || chunk.cy < 0 || chunk.cy >= 3) throw new Error('invalid chunk identity');
  if (!chunk.palette.length || chunk.palette.length > 16 || chunk.ground.length !== size * size / 2 || chunk.solid.length !== size * size / 8) throw new Error('invalid cell packing');
  for (const cell of chunk.ground) if ((cell & 15) >= chunk.palette.length || (cell >> 4) >= chunk.palette.length) throw new Error('invalid palette index');
  const tile = (x: number, y: number) => { if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) throw new Error('tile outside chunk'); };
  if (!chunk.spawn) throw new Error('missing spawn');
  tile(chunk.spawn.tx, chunk.spawn.ty);
  const decor = chunk.decor;
  if (!decor) throw new Error('missing decor');
  const count = decor.kind.length;
  if ([decor.tx, decor.ty, decor.ox, decor.oy, decor.variant].some(a => a.length !== count) || decor.flags.length !== Math.ceil(count / 4)) throw new Error('invalid decor packing');
  for (let i = 0; i < count; i++) { if (decor.kind[i]! >= decor.kinds.length) throw new Error('invalid decor kind'); tile(decor.tx[i]!, decor.ty[i]!); }
  const ids = new Set<string>();
  for (const item of [...chunk.entities, ...chunk.sites]) { if (!item.id || ids.has(item.id)) throw new Error('duplicate geometry id'); ids.add(item.id); tile(item.tx, item.ty); }
  for (const site of chunk.sites) if (site.kind < SiteKind.ECHO || site.kind > SiteKind.REEDS) throw new Error('unknown site kind');
  for (const entity of chunk.entities) {
    if (!['camp', 'node', 'chest', 'poi'].includes(entity.kind)) throw new Error('unknown entity kind');
    if (entity.kind === 'camp' && (!entity.enemies.length || entity.enemies.some(e => !e)) || entity.kind === 'node' && !entity.material || entity.kind === 'chest' && (entity.tier < 1 || entity.tier > 3) || entity.kind === 'poi' && !entity.poi) throw new Error('missing entity body');
  }
  for (const exit of chunk.exits) {
    tile(exit.tx, exit.ty);
    if (!exit.tw || !exit.th || exit.tx + exit.tw > size || exit.ty + exit.th > size || ![Dir.NORTH, Dir.EAST, Dir.SOUTH, Dir.WEST].includes(exit.dir) || !exit.entry) throw new Error('invalid exit');
    const [width, height] = destinationSize(exit.to);
    if (exit.entry.tx >= width || exit.entry.ty >= height) throw new Error('invalid destination entry');
  }
  return chunk;
}
export function decodeChunk(bytes: Uint8Array): WildsChunk { return validateChunk(fromBinary(WildsChunkSchema, bytes)); }
export function entityIn(chunk: WildsChunk, id: string): WildsEntity | undefined { return chunk.entities.find(e => e.id === id); }
export function decorAt(chunk: WildsChunk, tx: number, ty: number): number[] { return chunk.decor?.tx.flatMap((x, i) => x === tx && chunk.decor!.ty[i] === ty ? [i] : []) ?? []; }
export type ChunkKey = { world: string; epoch: string; layer: number; cx: number; cy: number };
export interface ChunkSource { chunk(key: ChunkKey): Promise<WildsChunk>; }
export type PortErrorCode = 'missing' | 'epoch-ended' | 'unavailable';
export class PortError extends Error { readonly code: PortErrorCode; constructor(code: PortErrorCode) { super(code); this.code = code; } }
export class FakeChunks implements ChunkSource {
  readonly values = new Map<string, WildsChunk | PortError>();
  readonly calls: ChunkKey[] = [];
  static key(key: ChunkKey): string { return JSON.stringify([key.world, key.epoch, key.layer, key.cx, key.cy]); }
  async chunk(key: ChunkKey): Promise<WildsChunk> {
    this.calls.push({ ...key });
    const value = this.values.get(FakeChunks.key(key));
    if (!value) throw new PortError('missing');
    if (value instanceof PortError) throw value;
    return clone(WildsChunkSchema, value);
  }
}

/** Coordinates and radius are in tiles, measured from tile centres. */
export function decorWithin(chunk: WildsChunk, x: number, y: number, radius: number): number[] {
  if (radius < 0) return [];
  return chunk.decor?.tx.flatMap((tx, i) => (tx + 0.5 - x) ** 2 + (chunk.decor!.ty[i]! + 0.5 - y) ** 2 <= radius ** 2 ? [i] : []) ?? [];
}
