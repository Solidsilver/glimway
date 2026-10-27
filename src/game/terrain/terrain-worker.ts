/**
 * Bakes height terrain chunks off the main thread (./bake-away.ts starts
 * it). In: a BakeJob; out: the image, transferred, and the time it took.
 * The same pure bake as the main thread's fallback (./bake.ts).
 */
import { bakeChunk, type BakeJob } from './bake.ts'

const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; job: BakeJob }>) => void) | null; postMessage: (msg: unknown, transfer: Transferable[]) => void }

ctx.onmessage = (e) => {
  const start = performance.now()
  const baked = bakeChunk(e.data.job)
  ctx.postMessage({ id: e.data.id, baked, ms: performance.now() - start }, [baked.rgba.buffer as ArrayBuffer])
}
