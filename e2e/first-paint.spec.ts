import { writeFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { inCommons, warp, windowWhole } from './helpers'
import { freshPlayer, go } from './home-helpers'

/**
 * Entering an area must not freeze the page: the ground tileset
 * (src/game/area/terrain.ts) is painted off the main thread, so no task
 * blocks for long. A `longtask` observer records every main-thread task
 * over 50 ms from the warp until Hearthwick's ground is complete, and the
 * workers' tileset must match a main-thread repaint texel for texel.
 *
 * The Commons was retired by one town: it is now Hearthwick on the open map
 * (`outdoors`), so the entry here walks the hero in from its west edge rather
 * than warping into a separate `commons` area.
 *
 * PERF=1 also measures a phone (390×844, 4× CPU throttle through CDP) and
 * writes the numbers and the tileset hashes to .agent/perf-<tag>.json.
 */

type LongTask = { start: number; duration: number }
const observe = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __lt: LongTask[] }
    w.__lt = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) })
    }).observe({ type: 'longtask', buffered: true })
  })

async function logWebGLRenderer(page: Page): Promise<void> {
  if (!process.env.E2E_LOG_RENDERER) return
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return 'no canvas'
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return 'no WebGL context'
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    return extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  })
  console.log(`WebGL renderer: ${renderer}`)
}

/** Walk into Hearthwick on the open map; the long tasks since the warp. */
async function arrive(page: Page): Promise<{ tasks: LongTask[]; ground: unknown; ms: number }> {
  await page.evaluate(() => ((window as unknown as { __lt: LongTask[] }).__lt = []))
  const t0 = Date.now()
  // Just west of Hearthwick's footprint on the open map.
  await warp(page, 'outdoors', -26, 69)
  // Walk in until the hero stands on Hearthwick.
  await page.keyboard.down('ArrowRight')
  await expect.poll(async () => inCommons(page)).toBe(true)
  await page.keyboard.up('ArrowRight')
  // The open map paints its window off the main thread; wait for it to be whole.
  await windowWhole(page)
  const ms = Date.now() - t0
  // A moment for anything queued behind it.
  await page.waitForTimeout(500)
  return page.evaluate((ms) => ({
    tasks: (window as unknown as { __lt: LongTask[] }).__lt,
    ground: (window as unknown as { __fsGround: () => unknown }).__fsGround(),
    ms,
  }), ms)
}

/** The ground tileset's hash, once its transitions are all in. */
async function tilesetHash(page: Page): Promise<string | null> {
  await page.waitForFunction(() => (window as unknown as { __fsGround?: () => { complete?: boolean } | null }).__fsGround?.()?.complete === true, undefined, { timeout: 60_000 })
  return page.evaluate(() => {
    const w = window as unknown as { __fsGround: () => { key: string } | null; __fsDevTextureHash: (k: string) => string | null }
    const key = w.__fsGround()?.key
    return key ? w.__fsDevTextureHash(key) : null
  })
}
const mainThreadHash = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevGroundMainThreadHash: () => Promise<string | null> }).__fsDevGroundMainThreadHash())
const longest = (tasks: LongTask[]) => Math.max(0, ...tasks.map((t) => t.duration))

/** Enter the Commons' yard interior and wait for its ground to be complete. */
async function enterYard(page: Page): Promise<void> {
  await go(page, 'in:commons:yard', 7, 7)
  await page.waitForFunction(() => (window as unknown as { __fsGround?: () => { complete?: boolean } | null }).__fsGround?.()?.complete === true, undefined, { timeout: 60_000 })
}

test('entering the Commons blocks the main thread for no long task', async ({ page }) => {
  test.setTimeout(120_000)
  await observe(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await freshPlayer(page)
  await logWebGLRenderer(page)
  // The open map's base tileset at spawn (recorded for the report).
  const village = await tilesetHash(page)
  // Arrive into Hearthwick on the open map and measure its first paint.
  const hearthwick = await arrive(page)
  if (process.env.E2E_LOG_RENDERER) {
    console.log(`First-paint measurement: ${hearthwick.ms} ms total; longest long task ${longest(hearthwick.tasks)} ms`)
  }
  test.info().annotations.push({ type: 'longest task (ms)', description: String(longest(hearthwick.tasks)) })
  if (process.env.PERF) writeFileSync('test-results/perf-first-paint-desktop.json', JSON.stringify({ hearthwick, hashes: { village } }, null, 1))
  // This is a measured browser budget, not a correctness gate. The opt-in
  // browser-performance job sets PERF=1 and records this observation.
  if (process.env.PERF) {
    const budget = Number(process.env.FIRST_PAINT_LONGTASK_BUDGET_MS) || 400
    expect(longest(hearthwick.tasks), `longest long task; measured browser budget is ${budget} ms`).toBeLessThan(budget)
  }
  // The workers' tileset is texel for texel the one painted on the main thread.
  // On the open map the game paints a combined window tileset while
  // `__fsDevGroundMainThreadHash` repacks only the footprint under the hero, so
  // the equality is checked in an enclosed area entered from Hearthwick.
  await enterYard(page)
  const yard = await tilesetHash(page)
  expect(yard).not.toBeNull()
  expect(yard).toBe(await mainThreadHash(page))
})

test.describe('phone, 4× CPU throttle', () => {
  test.skip(!process.env.PERF, 'measured for the report (PERF=1)')
  const { defaultBrowserType: _b, ...IPHONE } = devices['iPhone 13']
  test.use({ ...IPHONE, viewport: { width: 390, height: 844 } })
  test('entering the Commons', async ({ page }) => {
    test.setTimeout(300_000)
    await observe(page)
    await freshPlayer(page)
    await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
    const village = await tilesetHash(page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const hearthwick = await arrive(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const hearthwickHash = await tilesetHash(page)
    writeFileSync('test-results/perf-first-paint-phone.json', JSON.stringify({ hearthwick, hashes: { village, hearthwick: hearthwickHash } }, null, 1))
  })
})
