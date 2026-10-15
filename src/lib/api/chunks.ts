import { PLOT_REVISION, lotAt, plotIdentity } from '../lots.ts';
import { clone, fromBinary } from '@bufbuild/protobuf';
import { ChunkSource as ChunkSourceKind, WorldChunkSchema, SiteKind, type WorldChunk, type WildsEntity } from '../gen/glimway/v1/wilds_pb.js';
import { loadWilds } from '../wilds/data.ts';
import { sourceOf } from '../location.ts';
import { TERRAIN } from '../tile.ts';

/**
 * The open map's chunk validator (open-map.md 2.5): a chunk's identity
 * (realm, layer, generator version, epoch; signed coordinates, any of
 * them), its sizes and palette, its decor packing, and that every piece,
 * entity, site and place sits inside it.
 */
export const CHUNK_SIZE = 24;
const LOOKS = ['tangle', 'outer'];

export function validateChunk(chunk: WorldChunk): WorldChunk {
  if (chunk.source === ChunkSourceKind.FIXED) return validateFixedChunk(chunk);
  const w = loadWilds();
  const size = chunk.size;
  if (chunk.source !== ChunkSourceKind.UNSPECIFIED || chunk.layoutRevision !== 0 || chunk.objects.length || chunk.epochId.startsWith('fixed:') || chunk.epochId.startsWith('plot:') || size !== CHUNK_SIZE || size !== w.chunkSize || !chunk.epochId || chunk.generatorVersion !== w.generatorVersion || chunk.realm !== w.realm || chunk.layer !== 0 || !LOOKS.includes(chunk.look) || !Number.isInteger(chunk.cx) || !Number.isInteger(chunk.cy)) throw new Error('invalid chunk identity');
  if (chunk.tier < 1 || chunk.tier > w.tiers.length || !w.lands.some((l) => l.id === chunk.land)) throw new Error('invalid chunk tier or land');
  if (!chunk.palette.length || chunk.palette.length > 16 || chunk.ground.length !== size * size / 2 || chunk.solid.length !== size * size / 8) throw new Error('invalid cell packing');
  for (const cell of chunk.ground) if ((cell & 15) >= chunk.palette.length || (cell >> 4) >= chunk.palette.length) throw new Error('invalid palette index');
  const tile = (x: number, y: number) => { if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) throw new Error('tile outside chunk'); };
  const decor = chunk.decor;
  if (!decor) throw new Error('missing decor');
  const count = decor.kind.length;
  if ([decor.tx, decor.ty, decor.ox, decor.oy, decor.variant].some(a => a.length !== count) || decor.flags.length !== Math.ceil(count / 4)) throw new Error('invalid decor packing');
  for (let i = 0; i < count; i++) { if (decor.kind[i]! >= decor.kinds.length) throw new Error('invalid decor kind'); tile(decor.tx[i]!, decor.ty[i]!); }
  const ids = new Set<string>();
  for (const item of [...chunk.entities, ...chunk.sites, ...chunk.places]) { if (!item.id || ids.has(item.id)) throw new Error('duplicate geometry id'); ids.add(item.id); tile(item.tx, item.ty); }
  for (const site of chunk.sites) if (site.kind < SiteKind.ECHO || site.kind > SiteKind.RUMOUR) throw new Error('unknown site kind');
  for (const entity of chunk.entities) {
    if (!['camp', 'node', 'chest', 'poi'].includes(entity.kind)) throw new Error('unknown entity kind');
    if (entity.kind === 'camp' && (!entity.enemies.length || entity.enemies.some(e => !e)) || entity.kind === 'node' && !entity.material || entity.kind === 'chest' && (entity.tier < 1 || entity.tier > w.tiers.length) || entity.kind === 'poi' && !entity.poi) throw new Error('missing entity body');
  }
  for (const place of chunk.places) if (!/^place:-?\d+:-?\d+$/.test(place.id) || !w.placeKinds.some((k) => k.id === place.kind)) throw new Error('invalid place mark');
  return chunk;
}
/** A fixed chunk's pseudo-epoch: "fixed:<layout>@<revision>" (server/internal/chunks/fixed.go). */
export function fixedEpoch(layout: string, revision: number): string { return `fixed:${layout}@${revision}`; }
const FIXED_KINDS = ['tree', 'bush', 'rock', 'overhang', 'prop', 'lamp', 'scenery', 'well', 'board', 'gate', 'sign', 'shelf', 'exit', 'npc-post', 'repair', 'gather'];
/**
 * A fixed chunk (location-seam.md 1.4), the twin of the server's
 * validateFixed: its pseudo-epoch names the layout and revision the places
 * give its coordinates, its palette curated terrains, and it carries
 * objects of known kinds on its own tiles with unique ids, nothing generated.
 */
function validateFixedChunk(chunk: WorldChunk): WorldChunk {
  const w = loadWilds();
  const size = chunk.size;
  const src = sourceOf(chunk.cx, chunk.cy);
  if (size !== CHUNK_SIZE || chunk.realm !== w.realm || chunk.layer !== 0 || chunk.generatorVersion !== 0 || !Number.isInteger(chunk.cx) || !Number.isInteger(chunk.cy)) throw new Error('invalid chunk identity');
  if (src.kind !== 'fixed' || (plotIdentity(chunk.epochId) ? !['lots-west', 'lots-east'].includes(src.layout) || src.revision !== PLOT_REVISION || plotIdentity(chunk.epochId)!.gate !== lotAt(chunk.cx, chunk.cy) : chunk.epochId !== fixedEpoch(src.layout, src.revision)) || chunk.layoutRevision !== src.revision) throw new Error('unknown layout');
  if ((chunk.look && !(plotIdentity(chunk.epochId) && chunk.look === 'tangle')) || chunk.mark || chunk.tier || chunk.land || chunk.decor || chunk.sites.length || chunk.entities.length || chunk.places.length) throw new Error('a fixed chunk carries generated geometry');
  if (!chunk.palette.length || chunk.palette.length > 16 || chunk.ground.length !== size * size / 2 || chunk.solid.length !== size * size / 8) throw new Error('invalid cell packing');
  if (chunk.palette.some((p) => !Object.hasOwn(TERRAIN, p))) throw new Error('unknown terrain');
  for (const cell of chunk.ground) if ((cell & 15) >= chunk.palette.length || (cell >> 4) >= chunk.palette.length) throw new Error('invalid palette index');
  const ids = new Set<string>();
  for (const o of chunk.objects) {
    if (!o.id || o.id.length > 64 || ids.has(o.id) || !FIXED_KINDS.includes(o.kind) || o.tx >= size || o.ty >= size) throw new Error('invalid object');
    ids.add(o.id);
  }
  return chunk;
}
export function decodeChunk(bytes: Uint8Array): WorldChunk { return validateChunk(fromBinary(WorldChunkSchema, bytes)); }
export function entityIn(chunk: WorldChunk, id: string): WildsEntity | undefined { return chunk.entities.find(e => e.id === id); }
export function decorAt(chunk: WorldChunk, tx: number, ty: number): number[] { return chunk.decor?.tx.flatMap((x, i) => x === tx && chunk.decor!.ty[i] === ty ? [i] : []) ?? []; }
export type ChunkKey = { world: string; epoch: string; layer: number; cx: number; cy: number };
export interface ChunkSource { chunk(key: ChunkKey): Promise<WorldChunk>; }
export type PortErrorCode = 'missing' | 'epoch-ended' | 'unavailable';
export class PortError extends Error { readonly code: PortErrorCode; constructor(code: PortErrorCode) { super(code); this.code = code; } }
export class FakeChunks implements ChunkSource {
  readonly values = new Map<string, WorldChunk | PortError>();
  readonly calls: ChunkKey[] = [];
  static key(key: ChunkKey): string { return JSON.stringify([key.world, key.epoch, key.layer, key.cx, key.cy]); }
  async chunk(key: ChunkKey): Promise<WorldChunk> {
    this.calls.push({ ...key });
    const value = this.values.get(FakeChunks.key(key));
    if (!value) throw new PortError('missing');
    if (value instanceof PortError) throw value;
    return clone(WorldChunkSchema, value);
  }
}
