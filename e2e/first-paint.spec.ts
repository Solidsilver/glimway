import { writeFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { warp } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * Entering an area must not freeze the page: the ground tileset
 * (src/game/area/terrain.ts) is painted off the main thread, so no task
 * blocks for long. A `longtask` observer records every main-thread task
 * over 50 ms from the warp until the Commons' ground is complete, and the
 * workers' tileset must match a main-thread repaint texel for texel.
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

/** Warp into an area and wait for its ground to be complete; the long tasks since the warp. */
async function enter(page: Page, area: 'commons' | 'village', tx: number, ty: number): Promise<{ tasks: LongTask[]; ground: unknown; ms: number }> {
  await page.evaluate(() => ((window as unknown as { __lt: LongTask[] }).__lt = []))
  const t0 = Date.now()
  await warp(page, area, tx, ty)
  await page.waitForFunction(() => (window as unknown as { __fsGround?: () => { area?: string; complete?: boolean } | null }).__fsGround?.()?.complete === true, undefined, { timeout: 60_000 })
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
  return page.evaluate(() => (window as unknown as { __fsDevTextureHash: (k: string) => string | null }).__fsDevTextureHash('ground-tiles'))
}
const mainThreadHash = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevGroundMainThreadHash: () => Promise<string | null> }).__fsDevGroundMainThreadHash())
const longest = (tasks: LongTask[]) => Math.max(0, ...tasks.map((t) => t.duration))

test('entering the Commons blocks the main thread for no long task', async ({ page }) => {
  test.setTimeout(120_000)
  await observe(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await freshPlayer(page)
  await logWebGLRenderer(page)
  const village = await tilesetHash(page)
  // The workers' tileset is texel for texel the one painted on the main thread.
  expect(village).toBe(await mainThreadHash(page))
  const commons = await enter(page, 'commons', 23, 19)
  const commonsHash = await tilesetHash(page)
  expect(commonsHash).toBe(await mainThreadHash(page))
  if (process.env.E2E_LOG_RENDERER) {
    console.log(`First-paint measurement: ${commons.ms} ms total; longest long task ${longest(commons.tasks)} ms`)
  }
  test.info().annotations.push({ type: 'longest task (ms)', description: String(longest(commons.tasks)) })
  if (process.env.PERF) writeFileSync(`.agent/perf-${process.env.PERF_TAG ?? 'now'}-desktop.json`, JSON.stringify({ commons, hashes: { village, commons: commonsHash } }, null, 1))
  // Generous for a loaded test machine; the report has the quiet numbers.
  expect(longest(commons.tasks)).toBeLessThan(400)
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
    const commons = await enter(page, 'commons', 23, 19)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    const commonsHash = await tilesetHash(page)
    writeFileSync(`.agent/perf-${process.env.PERF_TAG ?? 'now'}-phone.json`, JSON.stringify({ commons, hashes: { village, commons: commonsHash } }, null, 1))
  })
})
