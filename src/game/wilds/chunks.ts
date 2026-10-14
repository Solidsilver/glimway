/**
 * The Wilds' chunks on this device (server-first.md 3.3). Chunks are
 * immutable per epoch, so each is fetched once (GET /api/wilds/chunk/…),
 * validated, and kept: decoded in memory for the scenes, and as raw bytes in
 * IndexedDB (`glimway-chunks`) so a reload doesn't fetch them again.
 *
 * The cache never decides which epoch is current. Chunks are loaded only for
 * the epochs a fresh near read has just named (game/wilds/store.ts), so a
 * cached chunk can never stand in for an ended epoch. Keys carry the contract
 * and generator version, `<contract>:<generatorVersion>:<epochId>:<cx>:<cy>`;
 * entries of other versions or of epochs no longer current are deleted at
 * start and at each turning (pruneChunks).
 *
 * Fixed chunks (an authored layout's: the Commons) are cached the same way
 * under their pseudo-epoch, `fixed:<layout>@<revision>`, which content names
 * (src/lib/places.ts): kept whole rather than as terrain (loadFixedChunk),
 * never pruned while their revision is current, and let go when it isn't.
 */
import { toBinary } from '@bufbuild/protobuf';
import { CONTRACT_NUMBER } from '../../lib/contract.ts';
import { WorldChunkSchema, type WorldChunk } from '../../lib/gen/glimway/v1/wilds_pb.js';
import { decodeChunk, fixedEpoch } from '../../lib/api/chunks.ts';
import { PLACES } from '../../lib/places.ts';
import type { OperationsApi } from '../../lib/api/operations.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { terrainOf, type ChunkTerrain } from './terrain.ts';

const DB_NAME = 'glimway-chunks';
const STORE = 'chunks';
const PREFIX = `${CONTRACT_NUMBER}:${loadWilds().generatorVersion}:`;

const chunkKey = (epochId: string, cx: number, cy: number) => `${PREFIX}${epochId}:${cx}:${cy}`;

/** Decoded chunks, by key. */
const memory = new Map<string, ChunkTerrain>();
/** In-flight loads, so two callers share one fetch. */
const loading = new Map<string, Promise<ChunkTerrain>>();
/** Fixed chunks, whole, by key; and their in-flight loads. */
const fixedMemory = new Map<string, WorldChunk>();
const fixedLoading = new Map<string, Promise<WorldChunk>>();
/** The pseudo-epochs of the fixed chunks this build's content names. */
const FIXED_EPOCHS = PLACES.fixed.map((f) => fixedEpoch(f.layout, f.revision));

/** A chunk already loaded on this page, or null. */
export function cachedTerrain(epochId: string, cx: number, cy: number): ChunkTerrain | null {
  return memory.get(chunkKey(epochId, cx, cy)) ?? null;
}

/** Load one chunk of an epoch: memory, then IndexedDB, then the server. */
export function loadChunk(api: Pick<OperationsApi, 'chunk'>, epochId: string, cx: number, cy: number): Promise<ChunkTerrain> {
  const key = chunkKey(epochId, cx, cy);
  const ready = memory.get(key);
  if (ready) return Promise.resolve(ready);
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      const stored = await readStored(key);
      if (stored) {
        try {
          const chunk = decodeChunk(stored);
          if (chunk.epochId === epochId && chunk.cx === cx && chunk.cy === cy && chunk.layer === 0) return keep(key, terrainOf(chunk));
        } catch {
          // A stored chunk that no longer validates is fetched again.
        }
      }
      const chunk = await api.chunk(epochId, 0, cx, cy);
      const terrain = terrainOf(chunk);
      void writeStored(key, chunkBytes(chunk));
      return keep(key, terrain);
    })().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/**
 * Load one fixed chunk under its pseudo-epoch, whole: memory, then
 * IndexedDB, then the server (the same keys and store as the Wilds').
 */
export function loadFixedChunk(api: Pick<OperationsApi, 'chunk'>, epochId: string, cx: number, cy: number): Promise<WorldChunk> {
  const key = chunkKey(epochId, cx, cy);
  const ready = fixedMemory.get(key);
  if (ready) return Promise.resolve(ready);
  let pending = fixedLoading.get(key);
  if (!pending) {
    pending = (async () => {
      const stored = await readStored(key);
      if (stored) {
        try {
          const chunk = decodeChunk(stored);
          if (chunk.epochId === epochId && chunk.cx === cx && chunk.cy === cy && chunk.layer === 0) return keepFixed(key, chunk);
        } catch {
          // A stored chunk that no longer validates is fetched again.
        }
      }
      const chunk = await api.chunk(epochId, 0, cx, cy);
      void writeStored(key, chunkBytes(chunk));
      return keepFixed(key, chunk);
    })().finally(() => fixedLoading.delete(key));
    fixedLoading.set(key, pending);
  }
  return pending;
}

function keepFixed(key: string, chunk: WorldChunk): WorldChunk {
  fixedMemory.set(key, chunk);
  return chunk;
}

/** The cache key a chunk is kept under (test seam: the contract, generator version, epoch and chunk). */
export function chunkCacheKey(epochId: string, cx: number, cy: number): string {
  return chunkKey(epochId, cx, cy);
}

/**
 * Forget every chunk not of these epochs or of a current fixed layout, here
 * and in IndexedDB (and every other version's).
 */
export async function pruneChunks(currentEpochs: readonly string[], fixedEpochs: readonly string[] = FIXED_EPOCHS): Promise<void> {
  const kept = [...currentEpochs, ...fixedEpochs];
  const keepKey = (key: string) => key.startsWith(PREFIX) && kept.some((e) => key.startsWith(`${PREFIX}${e}:`));
  for (const key of [...fixedMemory.keys()]) if (!keepKey(key)) fixedMemory.delete(key);
  for (const key of [...memory.keys()]) if (!keepKey(key)) memory.delete(key);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (!keepKey(String(cursor.key))) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

function keep(key: string, terrain: ChunkTerrain): ChunkTerrain {
  memory.set(key, terrain);
  return terrain;
}

/** The raw bytes go to IndexedDB (re-encoded: the transport hands back the decoded chunk). */
function chunkBytes(chunk: WorldChunk): Uint8Array {
  return toBinary(WorldChunkSchema, chunk);
}

// ------------------------------------------------------------ IndexedDB

function openDb(): Promise<IDBDatabase | null> {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readStored(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function writeStored(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Storage is a convenience: the server keeps every chunk.
  } finally {
    db.close();
  }
}

/** Test seam: drop the in-memory chunks. */
export function forgetChunks(): void {
  memory.clear();
  loading.clear();
  fixedMemory.clear();
  fixedLoading.clear();
}
