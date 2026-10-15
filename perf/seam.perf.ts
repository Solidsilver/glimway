import { mkdirSync, writeFileSync } from 'node:fs'
import type { CDPSession } from '@playwright/test'
import { expect, test, type Page } from '../e2e/fixtures'
import { CONTRACT, pinWorld, serverState, waitForWorld } from '../e2e/connected'
import { freshPlayer, throughGate } from '../e2e/home-helpers'
import { parkCreatures, player, waitForWilds, warp, windowWhole } from '../e2e/helpers'

const OUT = process.env.PERF_OUT || 'test-results/perf'
const LABEL = process.env.PERF_LABEL || 'seam'
const CROSSINGS = 12
const LAPS = Number(process.env.PERF_SEAM_LAPS) || 10
const write = (mode: string, data: unknown) => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${LABEL}-${mode}.json`, JSON.stringify(data, null, 2))
}
const phase = (page: Page, name: string) => page.evaluate((n) => window.__fsPerfPhase!(n), name)
const report = (page: Page) => page.evaluate(() => window.__fsPerf!())
const reset = (page: Page) => page.evaluate(() => window.__fsPerfReset!())

async function enter(page: Page): Promise<number> {
  await freshPlayer(page)
  await pinWorld(page, 'perf-seam')
  await page.goto('/?perf=1')
  const begun = Date.now()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page)
  return Date.now() - begun
}

async function resources(page: Page, cdp: CDPSession) {
  // Collection pauses are measurement work, not walking frames.
  const previous = (await report(page)).phase
  await phase(page, 'resources')
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = await cdp.send('Runtime.getHeapUsage')
  const dom = await cdp.send('Memory.getDOMCounters')
  const scene = await page.evaluate(() => {
    const size = window.__fsSceneSize!()
    const memory = window.__fsDevTextureMemory!()
    return { ...size, totalTextures: Object.keys(memory.textures).length, textureBytes: memory.total }
  })
  await page.waitForTimeout(100)
  await phase(page, previous)
  return { heap: heap.usedSize as number, ...dom, ...scene }
}

/** Real steering through world-pixel waypoints; no teleporting inside a measured crossing. */
async function walk(page: Page, points: [number, number][]): Promise<void> {
  await page.evaluate((p) => window.__fsDevWalk!(p.map(([tx, ty]) => ({ x: tx * 16 + 8, y: ty * 16 + 12 }))), points)
  await expect.poll(() => page.evaluate(() => window.__fsDevWalking!()), { timeout: 20_000 }).toBe(false)
  const h = await player(page)
  const [tx, ty] = points.at(-1)!
  expect(Math.hypot(h.x - (tx * 16 + 8), h.y - (ty * 16 + 12))).toBeLessThan(5)
}

type Goal = { minTy?: number; maxTy?: number; minTx?: number; maxTx?: number }

/** A walkable route (world px) to the nearest open tile matching `goal` (as e2e/open-map.spec.ts). */
async function route(page: Page, goal: Goal, reach = 70): Promise<{ x: number; y: number }[] | null> {
  return page.evaluate(([g, reach]) => {
    const w = window as unknown as { __fsPlayer: () => { x: number; y: number }; __fsTileSolid: (x: number, y: number) => boolean }
    const p = w.__fsPlayer()
    const sx = Math.floor(p.x / 16)
    const sy = Math.floor(p.y / 16)
    const ok = (x: number, y: number) => (g.minTy === undefined || y >= g.minTy) && (g.maxTy === undefined || y <= g.maxTy) && (g.minTx === undefined || x >= g.minTx) && (g.maxTx === undefined || x <= g.maxTx)
    const key = (x: number, y: number) => `${x},${y}`
    const from = new Map<string, string | null>([[key(sx, sy), null]])
    const queue: [number, number][] = [[sx, sy]]
    while (queue.length) {
      const [x, y] = queue.shift()!
      if (ok(x, y)) {
        const out: { x: number; y: number }[] = []
        let k: string | null = key(x, y)
        while (k) {
          const [a, b] = k.split(',').map(Number)
          out.unshift({ x: a * 16 + 8, y: b * 16 + 12 })
          k = from.get(k) ?? null
        }
        return out
      }
      for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (Math.abs(nx - sx) > reach || Math.abs(ny - sy) > reach || from.has(key(nx, ny)) || w.__fsTileSolid(nx, ny)) continue
        from.set(key(nx, ny), key(x, y))
        queue.push([nx, ny])
      }
    }
    return null
  }, [goal, reach] as const)
}

/** Walk to the nearest open tile matching `goal`; false when no way was found or the walk kept stalling. */
async function walkTo(page: Page, goal: Goal): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
    let path = await route(page, goal)
    for (let tries = 0; !path && tries < 20; tries++) {
      await page.waitForTimeout(250)
      path = await route(page, goal)
    }
    if (!path) return false
    if (path.length <= 1) return true
    await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path)
    const done = await expect
      .poll(() => page.evaluate(() => (window as unknown as { __fsDevWalking: () => boolean }).__fsDevWalking()), { timeout: 30_000 })
      .toBe(false)
      .then(() => true, () => false)
    if (done) return true
  }
  return false
}

for (const mode of ['desktop', 'phone'] as const) {
  test.describe(`seam ${mode}`, () => {
    if (mode === 'phone') test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

    test('repeated straight, diagonal and turn-back crossings, plus chunk churn', async ({ page }) => {
      const cdp = await page.context().newCDPSession(page)
      const bootToPlayableMs = await enter(page)
      if (mode === 'phone') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      await warp(page, 'outdoors', 2, -12)
      await parkCreatures(page)
      await windowWhole(page)
      const arrival = await report(page)
      const id = await page.evaluate(() => window.__fsWildsWindow!()!.id)
      await reset(page)
      await phase(page, 'first-crossing')
      // First walk into the Commons attaches every fixed chunk on walking frames;
      // then warm both sides' slack before comparing identical resident windows.
      expect(await walkTo(page, { minTx: 2, maxTx: 2, minTy: 26, maxTy: 26 })).toBe(true)
      await walk(page, [[2, 21], [2, 26]])
      await windowWhole(page)
      await page.waitForTimeout(1500)
      const firstCrossing = await report(page)
      await phase(page, 'start')
      await reset(page)
      const start = await resources(page, cdp)
      const checkpoints = []
      const churnResources = []
      for (const pattern of ['straight', 'diagonal', 'turn-back']) {
        await phase(page, pattern)
        for (let i = 0; i < CROSSINGS / 2; i++) {
          if (pattern === 'straight') await walk(page, [[2, 21], [2, 26]])
          else if (pattern === 'diagonal') await walk(page, [[1, 25], [3, 23], [1, 25], [2, 26]])
          else await walk(page, [[2, 23], [2, 24], [2, 23], [2, 26]])
          expect(await page.evaluate(() => window.__fsWildsWindow!()!.id)).toBe(id)
        }
        checkpoints.push({ pattern, ...await resources(page, cdp) })
      }
      // Crossing the mouth stays inside slack. Also force real detach/reattach
      // beyond slack to expose retained fixed fixtures, not just resident chunks.
      await phase(page, 'churn')
      for (let i = 0; i < LAPS; i++) {
        expect(await walkTo(page, { maxTy: -12 })).toBe(true)
        await windowWhole(page)
        expect((await page.evaluate(() => window.__fsWildsWindow!()!.fixed)).length).toBe(0)
        expect(await walkTo(page, { minTx: 2, maxTx: 2, minTy: 26, maxTy: 26 })).toBe(true)
        expect(await page.evaluate(() => window.__fsWildsWindow!()!.id)).toBe(id)
        await parkCreatures(page)
        await windowWhole(page)
        churnResources.push({ lap: i + 1, ...await resources(page, cdp) })
      }
      await page.waitForTimeout(1500)
      const end = await resources(page, cdp)
      const r = await report(page)
      write(mode, { mode, cpuThrottle: mode === 'phone' ? 4 : 1, viewport: page.viewportSize(), dpr: await page.evaluate(() => devicePixelRatio), crossingsPerPattern: { straight: CROSSINGS, diagonal: CROSSINGS, 'turn-back': CROSSINGS * 2 }, buildBudgetMs: 4, bootToPlayableMs, arrival, firstCrossing, ...r, resources: { start, checkpoints, churnResources, end } })
      console.log(`seam ${mode}: ${JSON.stringify(r.phases)}; heap ${start.heap}→${end.heap}, list ${start.list}→${end.list}, textures ${start.textures}→${end.textures}`)
      expect(end.textures).toBe(start.textures)
      expect(end.listeners).toBe(start.listeners)
      expect(end.statics).toBe(start.statics)
    })

    test('two clients walk together with a peer drawn throughout', async ({ page, browser, baseURL }) => {
      await enter(page)
      const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
      const context = await browser.newContext({ baseURL, viewport: page.viewportSize()!, deviceScaleFactor: mode === 'phone' ? 3 : 1, isMobile: mode === 'phone', hasTouch: mode === 'phone' })
      try {
        const other = await context.newPage()
        await freshPlayer(other, 'Rowan', invite.code)
        await other.goto('/?perf=1')
        await other.getByTestId('continue-world').click()
        await waitForWorld(other)
        for (const p of [page, other]) {
          if (mode === 'phone') await (await p.context().newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
          await warp(p, 'outdoors', 2, 26)
          await parkCreatures(p)
          await windowWhole(p)
        }
        const visible = (p: Page) => p.evaluate(() => (window.__fsRemote!() as { alpha: number }[]).some((r) => r.alpha > 0))
        for (const p of [page, other]) await expect.poll(() => visible(p)).toBe(true)
        for (const p of [page, other]) { await reset(p); await phase(p, 'peer') }
        const rooms: unknown[] = []
        let missing = 0
        for (let i = 0; i < 6; i++) for (const ty of [21, 26]) {
          let sampling = true
          const monitor = (async () => {
            while (sampling) {
              if (!(await visible(page)) || !(await visible(other))) missing++
              await page.waitForTimeout(50)
            }
          })()
          try { await Promise.all([walk(page, [[2, ty]]), walk(other, [[2, ty]])]) }
          finally { sampling = false; await monitor }
          const expected = `outdoors:0:${ty < 24 ? 0 : 1}`
          for (const p of [page, other]) await expect.poll(() => p.evaluate(() => (window.__fsPresence!() as { area: string }).area)).toBe(expected)
          rooms.push({ expected, both: await Promise.all([page, other].map((p) => p.evaluate(() => window.__fsPresence!()))) })
        }
        write(`${mode}-peer`, { missing, rooms, clients: await Promise.all([report(page), report(other)]) })
        expect(missing, 'neither peer disappears in transit').toBe(0)
      } finally { await context.close() }
    })
  })
}

for (const network of ['slow-network', 'fixed-only'] as const) for (const from of ['boot', 'lot', 'tangle'] as const) {
  test(`seam arrival ${from}, ${network}`, async ({ page }) => {
    await enter(page)
    if (from === 'lot') await throughGate(page, 0)
    else await warp(page, 'outdoors', 2, from === 'boot' ? 26 : 22)
    await expect.poll(() => page.evaluate(() => window.__fsDevSaved!().pending)).toBe(false)
    const before = await player(page)
    // Drop page memory and persistent chunk cache, keeping this player's save.
    await page.goto('/?perf=1')
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('glimway-chunks')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('chunks', 'readwrite')
          tx.objectStore('chunks').clear()
          tx.oncomplete = () => { db.close(); resolve() }
        }
      })
    })
    const cdp = await page.context().newCDPSession(page)
    if (network === 'slow-network') await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 500_000, uploadThroughput: 100_000 })
    const reads: { url: string; start: number; end?: number; failed?: boolean }[] = []
    let releaseReads!: () => void
    const gate = new Promise<void>((resolve) => { releaseReads = resolve })
    await page.route('**/api/wilds/chunk/**', async (route) => {
      const url = decodeURIComponent(route.request().url())
      if (!url.includes('fixed:') && !url.includes('plot:')) return route.continue()
      const read = { url: route.request().url(), start: Date.now(), end: undefined as number | undefined }
      reads.push(read)
      if (network === 'fixed-only') {
        if (from === 'boot' && reads.length <= 6) {
          Object.assign(read, { failed: true, end: Date.now() })
          return route.abort('failed')
        }
        await gate
      }
      await route.continue()
      // Completion is recorded on the response, after the network delay.
      const response = await route.request().response()
      if (response) await response.finished()
      read.end = Date.now()
    })
    const begun = Date.now()
    await page.getByTestId('continue-world').click()
    await waitForWorld(page, 'outdoors')
    const visibleAt = Date.now()
    const release = setTimeout(releaseReads, 6000)
    // Measure visible pop-in independently of the three-second position
    // sample loop and of development modules loading before the scene.
    let outdoorVisibleAt = visibleAt
    const whole = (async () => {
      await page.waitForFunction(() => window.__fsWorld?.().areaId === 'outdoors' && !window.__fsSafety?.()?.transitioning && !!window.__fsWildsWindow?.())
      outdoorVisibleAt = Date.now()
      const key = from === 'lot' ? '-3,1' : '0,1'
      await page.waitForFunction((key) => {
        const w = window.__fsWildsWindow?.()
        return !!w?.ready && w.fixed.includes(key)
      }, key)
      return Date.now()
    })()
    const samples: { t: number; x: number; y: number; savedX: number; savedY: number; ground: number | null; attached: boolean; whole: boolean }[] = []
    const sample = () => page.evaluate(() => {
      const h = window.__fsPlayer!()
      const s = window.__fsDevSaved!()
      const w = window.__fsWildsWindow!()
      const key = `${Math.floor(h.x / 384)},${Math.floor(h.y / 384)}`
      return { t: performance.now(), x: h.x, y: h.y, savedX: s.position.x, savedY: s.position.y, ground: window.__fsGroundAt!(Math.floor(h.x / 16), Math.floor(h.y / 16)), attached: !!w?.attached.includes(key), whole: !!w?.ready }
    })
    // Both town and lot arrivals stay on outdoors; only the Tangle walks
    // towards the held fixed ground. Lots no longer have an exit transition.
    if (from === 'tangle') await page.keyboard.down('ArrowDown')
    try {
      for (let i = 0; i < 12; i++) {
        samples.push(await sample())
        await page.waitForTimeout(250)
      }
    } finally { if (from === 'tangle') await page.keyboard.up('ArrowDown') }
    samples.push(await sample())
    await waitForWilds(page)
    await windowWhole(page, 30_000)
    const wholeAt = await whole
    await expect.poll(() => reads.every((r) => r.end !== undefined)).toBe(true)
    const postDeliveryMs = Math.max(0, wholeAt - Math.max(outdoorVisibleAt, ...reads.filter((r) => !r.failed).map((r) => r.end!)))
    if (from === 'tangle') await walk(page, [[2, 26]])
    samples.push(await sample())
    write(`arrival-${from}-${network}`, { before, visibleMs: visibleAt - begun, outdoorVisibleMs: outdoorVisibleAt - begun, postDeliveryMs, elapsedMs: Date.now() - begun, reads, samples, perf: await report(page) })
    for (const s of samples) {
      expect(Math.hypot(s.x - s.savedX, s.y - s.savedY)).toBeLessThan(120)
      if ((from === 'boot' || from === 'lot') && !s.attached) {
        expect(Math.hypot(s.x - before.x, s.y - before.y)).toBeLessThan(1)
        expect(Math.hypot(s.savedX - before.x, s.savedY - before.y)).toBeLessThan(1)
      }
      if (from === 'tangle' && s.ground === null) expect(s.y).toBeLessThan(384)
    }
    const after = await player(page)
    const expected = from === 'lot' ? { tx: -61, ty: 32 } : { tx: 2, ty: 26 }
    expect(Math.floor(after.x / 16)).toBe(expected.tx)
    expect(Math.floor(after.y / 16)).toBe(expected.ty)
    expect(await page.evaluate(() => window.__fsTileSolid!(Math.floor(window.__fsPlayer!().x / 16), Math.floor(window.__fsPlayer!().y / 16)))).toBe(false)
    await expect.poll(async () => {
      const s = await page.evaluate(() => window.__fsDevSaved!())
      return !s.pending && Math.hypot(s.position.x - after.x, s.position.y - after.y) < 5
    }).toBe(true)
    const saved = await page.evaluate(() => window.__fsDevSaved!())
    expect(Math.hypot(saved.position.x - after.x, saved.position.y - after.y)).toBeLessThan(5)
    await expect.poll(async () => {
      const position = (await serverState(page)).body.state.position
      return Math.hypot(position.x - after.x, position.y - after.y)
    }, { timeout: 15_000 }).toBeLessThan(5)
    write(`arrival-${from}-${network}`, { before, after, saved, visibleMs: visibleAt - begun, outdoorVisibleMs: outdoorVisibleAt - begun, postDeliveryMs, elapsedMs: Date.now() - begun, reads, samples, perf: await report(page) })
    clearTimeout(release)
    expect(postDeliveryMs, 'drawing completes shortly after delivery').toBeLessThan(1500)
    expect(reads.length, 'cold fixed reads exercised').toBeGreaterThanOrEqual(6)
    expect(reads.length, 'bounded retries while delivery is held').toBeLessThanOrEqual(18)
  })
}
