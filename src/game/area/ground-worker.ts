/**
 * Paints ground transition overlays off the main thread (./terrain.ts
 * starts a few of these per tileset). In: a batch of overlay jobs, the
 * reference textures and the density; out: each painted cell, transferred.
 */
import { paintEdgeJobs, type EdgeJob } from './ground-paint.ts'

interface Request {
  id: number
  jobs: EdgeJob[]
  refs: Record<string, Uint8ClampedArray>
  k: number
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (msg: unknown, transfer: Transferable[]) => void }

ctx.onmessage = (e) => {
  const { id, jobs, refs, k } = e.data
  const cells = paintEdgeJobs(jobs, refs, k)
  ctx.postMessage({ id, cells }, cells.map((c) => c.rgba.buffer as ArrayBuffer))
}
