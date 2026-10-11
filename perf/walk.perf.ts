import { writeFileSync, mkdirSync } from 'node:fs'
import type { CDPSession } from '@playwright/test'
import { expect, test, type Page } from '../e2e/fixtures'
import { linkRev, serverState, sql, waitForWorld } from '../e2e/connected'
import { player, waitForWilds, warp } from '../e2e/helpers'
import { freshPlayer } from '../e2e/home-helpers'
import type { PerfReport } from '../src/game/perf'

/**
 * The walk (docs/testing.md, "Performance"): the open map with ?perf=1,
 * walked the same way every time, so a change to the window can be
 * measured against the last one.
 *
 *  1. new ground: north from the gate, chunk by chunk, then east (about
 *     eight chunks never seen before);
 *  2. the edge: back and forth over one chunk edge, ten times;
 *  3. the loop: two minutes over ground already walked, ending where it
 *     began (a leak shows as a display list or tween count that grew).
 *
 * Once at normal speed and once with the CPU throttled 4× (the owner's
 * machine stalls where a fast one may not), always on the same land (the
 * world's seed is pinned before its Wilds are first made). Writes a JSON
 * summary per run to PERF_OUT (default test-results/perf), named by
 * PERF_LABEL; PERF_TRACE=1 records a Chrome trace beside it
 * (scripts/trace-hotspots.mjs reads it). PERF_WITHOUT turns parts of the
 * window's work off, to measure each on its own (src/game/perf.ts
 * `perfWithout`, e.g. PERF_WITHOUT=bake,slack).
 *
 *   PERF_LABEL=baseline npx playwright test -c playwright.perf.config.ts
 *   npx playwright test -c playwright.perf.config.ts --grep throttled
 */

const S = 24
const OUT = process.env.PERF_OUT || 'test-results/perf'
const LABEL = process.env.PERF_LABEL || 'walk'
const LOOP_MS = Number(process.env.PERF_LOOP_MS) || 120_000
const QUERY = `?perf=1${process.env.PERF_WITHOUT ? `&without=${process.env.PERF_WITHOUT}` : ''}`

/**
 * The same land every run: a fresh world's seed is set before its Wilds are
 * first made (as e2e/open-map-screens.spec.ts pins its world).
 */
async function pinWorld(page: Page): Promise<void> {
  const world = (await serverState(page)).body.worldId as string
  sql(`DELETE FROM wilds_chunks WHERE epoch_id IN (SELECT id FROM wild_epochs WHERE world_id='${world}'); DELETE FROM wild_epochs WHERE world_id='${world}'; UPDATE worlds SET seed='perf-walk' WHERE id='${world}';`)
}

/** Into the game again with the instruments on (?perf=1 is read at load), on the pinned land. */
async function enter(page: Page, query: string): Promise<void> {
  await freshPlayer(page)
  await pinWorld(page)
  await expect.poll(async () => (await linkRev(page)) === (await serverState(page)).body.rev, { timeout: 15_000 }).toBe(true)
  await page.goto(`/${query}`)
  await page.getByTestId('continue-world').click()
  await waitForWorld(page)
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

const perf = (page: Page) => page.evaluate(() => (window as unknown as { __fsPerf: () => PerfReport }).__fsPerf())
const phase = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __fsPerfPhase: (n: string) => void }).__fsPerfPhase(n), name)
const scene = async (page: Page) => {
  const r = await perf(page)
  const s = r.samples[r.samples.length - 1]
  return { list: s?.list ?? 0, tweens: s?.tweens ?? 0, dom: s?.dom ?? 0 }
}
/** DOM nodes and listeners still alive (after a collection: the garbage isn't counted). */
const counters = async (cdp: CDPSession) => {
  await cdp.send('HeapProfiler.collectGarbage')
  const c = (await cdp.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
  return { nodes: c.nodes, listeners: c.jsEventListeners }
}

async function walk(page: Page, rate: number, mode: string): Promise<void> {
  test.setTimeout(20 * 60_000)
  const cdp = await page.context().newCDPSession(page)
  await enter(page, QUERY)
  await warp(page, 'wilds', 2, 20)
  await waitForWilds(page)
  await page.waitForTimeout(2000)
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  const tracing = process.env.PERF_TRACE === '1'
  mkdirSync(OUT, { recursive: true })
  if (tracing) await page.context().browser()!.startTracing(page, { path: `${OUT}/${LABEL}-${mode}.trace.json`, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'v8.execute'] })
  const domStart = await counters(cdp)
  await page.evaluate(() => (window as unknown as { __fsPerfReset: () => void }).__fsPerfReset())
  const missed: string[] = []

  // 1. New ground: north to the Beyond, then east along it.
  await phase(page, 'new')
  const goals: Goal[] = []
  for (let cy = -1; cy >= -6; cy--) goals.push({ maxTy: cy * S + S - 3 })
  goals.push({ minTx: S + 3 }, { minTx: 2 * S + 3 })
  for (const g of goals) if (!(await walkTo(page, g))) missed.push(JSON.stringify(g))
  await phase(page, 'settle')
  await page.waitForTimeout(1500)

  // 2. The edge: the west edge of the chunk we stand in, ten times there and back.
  await phase(page, 'edge')
  const here = await player(page)
  const edge = Math.floor(here.x / (S * 16)) * S
  for (let i = 0; i < 10; i++) {
    if (!(await walkTo(page, { maxTx: edge - 3 }))) missed.push(`edge west ${i}`)
    if (!(await walkTo(page, { minTx: edge + 2 }))) missed.push(`edge east ${i}`)
  }
  await phase(page, 'settle')
  await page.waitForTimeout(1500)

  // 3. The loop: over walked ground (west two chunks and back) for two minutes, ending where it began.
  const home = await player(page)
  const homeTile = { tx: Math.floor(home.x / 16), ty: Math.floor(home.y / 16) }
  await page.waitForTimeout(2500)
  const loopStart = await scene(page)
  await phase(page, 'loop')
  const until = Date.now() + LOOP_MS
  let laps = 0
  while (Date.now() < until) {
    if (!(await walkTo(page, { maxTx: edge - 2 * S + 3 }))) missed.push(`loop west ${laps}`)
    if (!(await walkTo(page, { minTx: homeTile.tx - 1, maxTx: homeTile.tx + 1, minTy: homeTile.ty - 1, maxTy: homeTile.ty + 1 }))) {
      // Stuck on the way (a creature, a corner): put the hero home and go on.
      missed.push(`loop home ${laps}`)
      await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [home.x, home.y] as const)
    }
    laps++
  }
  await phase(page, 'settle')
  // Back on the very tile it began on (a stalled last walk is put there), the window whole again.
  const at = await player(page)
  if (Math.floor(at.x / 16) !== homeTile.tx || Math.floor(at.y / 16) !== homeTile.ty) {
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [home.x, home.y] as const)
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsWildsWindow: () => { ready?: boolean; attached: string[] } | null }).__fsWildsWindow()?.ready ?? true), { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(2500)
  const loopEnd = await scene(page)
  const domEnd = await counters(cdp)
  if (tracing) await page.context().browser()!.stopTracing()
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

  const r = await perf(page)
  const longByPhase: Record<string, PerfReport['long']> = {}
  for (const l of r.long) (longByPhase[l.phase] ??= []).push(l)
  const summary = {
    label: LABEL,
    mode,
    without: process.env.PERF_WITHOUT ?? '',
    cpuThrottle: rate,
    observer: r.observer,
    phases: Object.fromEntries(['new', 'edge', 'loop'].map((p) => [p, { ...r.phases[p], longFrames: (longByPhase[p] ?? []).sort((a, b) => b.ms - a.ms).slice(0, 8) }])),
    loop: { laps, start: loopStart, end: loopEnd },
    dom: { start: domStart, end: domEnd },
    histogram: r.histogram,
    stages: r.stages,
    domAdded: r.domAdded,
    missed,
  }
  writeFileSync(`${OUT}/${LABEL}-${mode}.json`, JSON.stringify({ ...summary, samples: r.samples }, null, 1))
  const brief = (p: string) => {
    const f = r.phases[p]
    return f ? `${p}: frames ${f.frames} p50 ${f.p50} p95 ${f.p95} p99 ${f.p99} worst ${f.worst} >50ms ${f.over50} long ${f.long}` : `${p}: -`
  }
  console.log(`perf walk ${LABEL} ${mode}\n  ${['new', 'edge', 'loop'].map(brief).join('\n  ')}\n  loop list ${loopStart.list}→${loopEnd.list} tweens ${loopStart.tweens}→${loopEnd.tweens} dom ${domStart.nodes}→${domEnd.nodes} listeners ${domStart.listeners}→${domEnd.listeners}${missed.length ? `\n  missed ${missed.join(', ')}` : ''}`)
}

test('the walk, normal speed', async ({ page }) => {
  await walk(page, 1, 'normal')
})

test('the walk, CPU throttled 4×', async ({ page }) => {
  await walk(page, 4, 'throttled')
})

/**
 * The same spots of the same land, photographed for the look check
 * (PERF_LABEL names the set): reduced motion, so glints and motes hold
 * still, creatures set aside, and only the canvas shown (no HUD, no
 * overlay). Compare two sets with scripts/png-diff.ts.
 */
const SPOTS: { name: string; tx: number; ty: number }[] = [
  { name: 'gate', tx: 6, ty: 18 },
  { name: 'tangle', tx: 12, ty: -12 },
  { name: 'tangle-edge', tx: 23, ty: -36 },
  { name: 'whitequiet', tx: 12, ty: -60 },
  { name: 'beyond', tx: 12, ty: -132 },
  { name: 'beyond-east', tx: 60, ty: -132 },
]

test('the look, at fixed spots', async ({ page }) => {
  test.setTimeout(10 * 60_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enter(page, QUERY)
  await page.addStyleTag({ content: '* { visibility: hidden !important } canvas { visibility: visible !important }' })
  const dir = `${OUT}/screens/${LABEL}`
  mkdirSync(dir, { recursive: true })
  for (const s of SPOTS) {
    await warp(page, 'wilds', s.tx, s.ty)
    await waitForWilds(page)
    await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
    await page.waitForTimeout(2500)
    await page.locator('canvas').first().screenshot({ path: `${dir}/${s.name}.png` })
  }
})
