import test from 'node:test'
import assert from 'node:assert/strict'
import { PaintPool, paintSlices, refreshWhenPainted, startWorkers, type PaintedCell, type Painter } from '../src/game/area/ground-pool.ts'
import { edgeRefNames, paintEdgeJobs, type EdgeJob } from '../src/game/area/ground-paint.ts'
import { edgeKey, type GroundClass } from '../src/game/area/ground-field.ts'
import { artIdentity, baseBlocksKey, tilesetSignature } from '../src/game/area/terrain.ts'
import { buildArea } from '../src/game/worlds.ts'

/**
 * The ground painters' failure paths (review findings 1–3): a failed or
 * silent pool is disposed of whole and every paint still finishes; a
 * pending paint refreshes every texture that shows it; the paint caches
 * key on the art's content.
 */

type Mode = 'ok' | 'error' | 'silent'

class FakeWorker implements Painter {
  terminated = false
  posted = 0
  private listeners: Record<string, ((e: Event) => void)[]> = { message: [], error: [] }
  private mode: Mode
  constructor(mode: Mode) {
    this.mode = mode
  }
  addEventListener(type: 'message' | 'error', l: (e: Event) => void): void {
    this.listeners[type].push(l)
  }
  removeEventListener(type: 'message' | 'error', l: (e: Event) => void): void {
    this.listeners[type] = this.listeners[type].filter((x) => x !== l)
  }
  get listening(): number {
    return this.listeners.message.length + this.listeners.error.length
  }
  postMessage(msg: unknown): void {
    this.posted++
    const { id, jobs, refs, k } = msg as { id: number; jobs: EdgeJob[]; refs: Record<string, Uint8ClampedArray>; k: number }
    setTimeout(() => {
      if (this.terminated) return
      if (this.mode === 'ok') for (const l of [...this.listeners.message]) l({ data: { id, cells: paintEdgeJobs(jobs, refs, k) } } as unknown as Event)
      if (this.mode === 'error') for (const l of [...this.listeners.error]) l({ error: new Error('boom'), message: 'boom' } as unknown as Event)
    }, 5)
  }
  terminate(): void {
    this.terminated = true
  }
}

const k = 1
const refs = Object.fromEntries(edgeRefNames().map((n, j) => [n, new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i * 5 + j * 17) & 255)]))
const n: GroundClass[] = ['grass', 'grass', 'grass', 'dirt', 'dirt', 'grass', 'dirt', 'dirt', 'dirt']
const jobs: EdgeJob[] = Array.from({ length: 12 }, (_, i) => ({ key: edgeKey(n, i, 3)!, f: 0, i }))
const expected = new Map(paintEdgeJobs(jobs, refs, k).map((c) => [c.i, Array.from(c.rgba)]))

async function collect(run: (take: (cells: PaintedCell[]) => void) => Promise<void>): Promise<Map<number, number[]>> {
  const got = new Map<number, number[]>()
  await run((cells) => cells.forEach((c) => got.set(c.i, Array.from(c.rgba))))
  return got
}

test('pool: workers that answer paint every job, the same as the main thread', async () => {
  const made = [new FakeWorker('ok'), new FakeWorker('ok')]
  const pool = new PaintPool(() => made)
  const got = await collect((take) => pool.paint(jobs, refs, k, take))
  assert.deepEqual(got, expected)
  assert.equal(pool.waiting, 0)
  assert.ok(made.every((w) => w.listening === 0 && !w.terminated))
})

test('pool: a worker error terminates every worker, settles every job and finishes on the main thread', async () => {
  const made = [new FakeWorker('ok'), new FakeWorker('error'), new FakeWorker('silent')]
  const pool = new PaintPool(() => made)
  // Two paints at once: the failure must settle the other one's jobs too.
  const [a, b] = await Promise.all([collect((take) => pool.paint(jobs, refs, k, take)), collect((take) => pool.paint(jobs.slice(0, 5), refs, k, take))])
  assert.deepEqual(a, expected)
  assert.deepEqual([...b.keys()].sort((x, y) => x - y), [0, 1, 2, 3, 4])
  assert.ok(made.every((w) => w.terminated), 'every worker terminated')
  assert.ok(made.every((w) => w.listening === 0), 'no listeners left behind')
  assert.equal(pool.waiting, 0)
  assert.equal(pool.disposed, true)
  // Later paints run on the main thread.
  assert.deepEqual(await collect((take) => pool.paint(jobs, refs, k, take)), expected)
  assert.ok(made.every((w) => w.posted <= 2))
})

test('pool: a worker that never answers is caught by the watchdog', async () => {
  const made = [new FakeWorker('silent'), new FakeWorker('ok')]
  const pool = new PaintPool(() => made, 60)
  const t0 = Date.now()
  assert.deepEqual(await collect((take) => pool.paint(jobs, refs, k, take)), expected)
  assert.ok(Date.now() - t0 < 2000)
  assert.ok(made.every((w) => w.terminated && w.listening === 0))
  assert.equal(pool.waiting, 0)
})

test('pool: a partly started pool is disposed of, and paints run on the main thread', async () => {
  const made: FakeWorker[] = []
  let i = 0
  assert.throws(() =>
    startWorkers(3, () => {
      if (i++ === 2) throw new Error('no more workers')
      const w = new FakeWorker('ok')
      made.push(w)
      return w
    }),
  )
  assert.equal(made.length, 2)
  assert.ok(made.every((w) => w.terminated))
  const pool = new PaintPool(() => {
    throw new Error('no workers here')
  })
  assert.deepEqual(await collect((take) => pool.paint(jobs, refs, k, take)), expected)
  assert.equal(pool.disposed, true)
  assert.deepEqual(await collect((take) => paintSlices(jobs, refs, k, take)), expected)
})

test('a pending paint refreshes every texture still showing it, and no other', async () => {
  let land!: () => void
  const done = new Promise<void>((r) => (land = r))
  const canvas = {}
  const tex = (image: unknown) => ({ source: [{ image }], refreshed: 0, refresh() { this.refreshed++ } })
  // The first game's texture (destroyed with its game), the replacement
  // game's (a cache hit on the same pending paint), and one that has moved
  // on to another area's canvas.
  const first = tex(canvas)
  const second = tex(canvas)
  const other = tex({})
  let completions = 0
  refreshWhenPainted(done, first, canvas)
  refreshWhenPainted(done, second, canvas, () => completions++)
  refreshWhenPainted(done, other, canvas)
  first.source = []
  land()
  await done
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual([first.refreshed, second.refreshed, other.refreshed, completions], [0, 1, 0, 1])
})

test('the paint caches key on the art’s content: a redeployed image with the same layout misses', () => {
  const manifest = (ground: string, terrain: string) => ({
    ground: { image: 'ground.webp', size: [384, 448] as [number, number], cell: 64, density: 4, cols: 6, tiles: { a: 0 }, healed: true },
    terrain: { image: 'terrain.webp', size: [256, 256] as [number, number], cell: 64, density: 4 },
    outputs: { 'ground.webp': ground, 'terrain.webp': terrain },
  })
  const before = artIdentity(manifest('g1', 't1'))
  const newGround = artIdentity(manifest('g2', 't1'))
  const newTerrain = artIdentity(manifest('g1', 't2'))
  assert.notEqual(before, newGround)
  assert.notEqual(before, newTerrain)
  const m = manifest('g1', 't1')
  const w = buildArea('village')
  const sig = (art: string) => tilesetSignature(w, new Map(), 4, ['a'], null, m.ground, art)
  assert.notEqual(sig(before), sig(newGround))
  assert.notEqual(baseBlocksKey(64, before, m.ground, null), baseBlocksKey(64, newTerrain, m.ground, null))
  assert.equal(sig(before), sig(artIdentity(manifest('g1', 't1'))), 'the same art hits')
})
