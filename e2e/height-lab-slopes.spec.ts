import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { freshPlayer } from './home-helpers'
import { SLOPE_PRESETS, type LabLook, type SlopePreset } from '../src/game/height-lab/look'

/** Round 2a: matching overlay-free frames, field travel times, and browser frame
 * tails during walking and scene-rebuilding preset changes. CI only. */
const OUT = '.e2e-artifacts/height-lab/slopes'
const FEATURES = ['hills', 'pass-top', 'pass-north', 'outcrop-cliff', 'steep-band', 'rocky-path']
const PRESETS = Object.keys(SLOPE_PRESETS) as SlopePreset[]
type Look = Partial<LabLook>
type Spot = { name: string; x: number; y: number; fx: number; fy: number; look: [number, number] | null }
type FrameWindow = { __frames: number[]; __framesId?: number; __longTasks: { start: number; ms: number }[]; __longTaskObserver?: PerformanceObserver }
type Times = { frames: number; p50: number; p95: number; max: number }
type Slopes = { preset: SlopePreset; at: [number, number]; tile: [number, number]; silhouette: boolean; kind: number; pending: number; slow: unknown[]; paint: Times; upload: Times; update: Times; spots: Spot[] }
type LabState = { area: string; look: LabLook; built: Look; z?: number; slopes?: Slopes }
type Run = { seconds: number; px: number; kMin: number; kMax: number; blocked: boolean; from: [number, number]; to: [number, number] }
type Lab = { put: (layer: number, tx: number, ty: number, look?: [number, number]) => void; step: (dx: number, dy: number) => void; run: (dx: number, dy: number, px: number) => Run; look: (l: Look) => void; state: () => LabState }
const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function openLab(page: Page) {
  await freshPlayer(page)
  await page.goto('/?lab=height')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await page.waitForFunction(() => !!(window as unknown as { __fsLab?: unknown }).__fsLab, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1200)
}
async function painted(page: Page) {
  await expect.poll(async () => (await labState(page)).slopes?.pending ?? 0, { timeout: 60_000 }).toBe(0)
}
async function setLook(page: Page, look: Look) {
  await page.evaluate((l) => (window as unknown as { __fsLab: Lab }).__fsLab.look(l), look)
  const rebuilds = ['area', 'slopeFacing', 'slopeContours', 'slopeTerraces', 'slopeLift']
  await expect.poll(async () => {
    const st = await page.evaluate(() => (window as unknown as { __fsLab?: Lab }).__fsLab?.state())
    if (!st) return false
    return Object.keys(look).every((k) => ((rebuilds.includes(k) ? st.built : st.look) as Record<string, unknown>)[k] === (look as Record<string, unknown>)[k]) && (st.built.area !== 'slopes' || !!st.slopes)
  }, { timeout: 60_000 }).toBe(true)
}
async function hudOff(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="height-lab-hud"]')
    if (el) el.style.visibility = 'hidden'
  })
}
async function put(page: Page, spot: Spot) {
  await page.evaluate(([x, y, look]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, x, y, look ?? undefined), [spot.x, spot.y, spot.look] as const)
}
async function save(page: Page, name: string) {
  await painted(page)
  await hudOff(page)
  await page.waitForTimeout(500)
  const st = await labState(page)
  expect(st.look.grid).toBe(false)
  expect(st.look.walkOverlay).toBe(false)
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(st, null, 1))
  await page.screenshot({ path: `${OUT}/${name}.png` })
  return st
}
async function shot(page: Page, name: string, spot: Spot) {
  await put(page, spot)
  return save(page, name)
}

/** rAF recording lives outside Phaser so a scene restart cannot reset it. */
async function startFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as FrameWindow
    w.__frames = []
    w.__longTaskObserver?.disconnect()
    w.__longTasks = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      w.__longTaskObserver = new PerformanceObserver((list) => {
        w.__longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, ms: e.duration })))
      })
      w.__longTaskObserver.observe({ type: 'longtask' })
    }
    const id = w.__framesId = (w.__framesId ?? 0) + 1
    let last = performance.now()
    const tick = (t: number) => {
      if (w.__framesId !== id) return
      w.__frames.push(t - last)
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.waitForTimeout(50)
}
async function endFrames(page: Page) {
  const { raw, longTasks } = await page.evaluate(() => {
    const w = window as unknown as FrameWindow
    w.__framesId = (w.__framesId ?? 0) + 1
    const pending = w.__longTaskObserver?.takeRecords() ?? []
    w.__longTasks.push(...pending.map((e) => ({ start: e.startTime, ms: e.duration })))
    w.__longTaskObserver?.disconnect()
    return { raw: w.__frames.slice(1), longTasks: w.__longTasks }
  })
  const s = [...raw].sort((a, b) => a - b)
  return { frames: s.length, p50: s[s.length >> 1] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0, p99: s[Math.floor(s.length * 0.99)] ?? 0, max: s.at(-1) ?? 0, over33: s.filter((x) => x > 33).length, over50: s.filter((x) => x > 50).length, raw, longTasks }
}
async function walkTimed(page: Page, key: string, ms: number) {
  await startFrames(page)
  await page.keyboard.down(key)
  try { await page.waitForTimeout(ms) } finally { await page.keyboard.up(key) }
  return endFrames(page)
}

/** Pixel positions mirror the knoll node tests; put() adds 8 to x and 12 to y. */
async function fieldRuns(page: Page) {
  return page.evaluate(() => {
    const lab = (window as unknown as { __fsLab: Lab }).__fsLab
    const at = (x: number, y: number) => lab.put(0, (x - 8) / 16, (y - 12) / 16)
    at(86 * 16, 96.5 * 16 + 2)
    const up = lab.run(0, -1, 56)
    const down = lab.run(0, 1, 56)
    at(91 * 16, 91 * 16 + 2)
    const across = lab.run(0, -1, 32)
    lab.look({ slopeUphill: 'off' })
    at(86 * 16, 96.5 * 16 + 2)
    const off = lab.run(0, -1, 56)
    lab.look({ slopeUphill: 'gentle' })
    return { up, down, across, off }
  })
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2a: five presets, matching frames and timing tails', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.full.look, slopeUphill: 'gentle', grid: false, walkOverlay: false, fog: 'fog', fogStrength: 'medium', zoom: true, haze: true })
    await painted(page)
    const first = (await labState(page)).slopes!
    writeFileSync(`${OUT}/spots.json`, JSON.stringify(first.spots, null, 1))
    const timing: Record<string, unknown> = {}
    let reference: Awaited<ReturnType<typeof fieldRuns>> | undefined
    for (const preset of PRESETS) {
      const before = (await labState(page)).slopes!.at
      await startFrames(page)
      await setLook(page, SLOPE_PRESETS[preset].look)
      expect((await labState(page)).slopes!.at, `${preset}: switch preserves position`).toEqual(before)
      await painted(page)
      await page.waitForTimeout(250)
      const switching = await endFrames(page)
      const st = (await labState(page)).slopes!
      expect(st.preset).toBe(preset)
      const spots = new Map(st.spots.map((s) => [s.name, s]))
      await put(page, spots.get('spawn')!)
      await painted(page)
      const east = await walkTimed(page, 'ArrowRight', 4000)
      const north = await walkTimed(page, 'ArrowUp', 3000)
      const walk = (await labState(page)).slopes!
      const runs = await fieldRuns(page)
      for (const r of Object.values(runs)) expect(r.blocked).toBe(false)
      expect(runs.up.px).toBeCloseTo(56, 5)
      expect(runs.down.seconds).toBeCloseTo(runs.off.seconds, 6)
      expect(runs.up.seconds / runs.off.seconds).toBeGreaterThan(1.08)
      expect(runs.up.seconds / runs.off.seconds).toBeLessThan(1.14)
      expect(runs.across.seconds / (runs.off.seconds * 32 / 56)).toBeCloseTo(1, 2)
      if (reference) for (const key of ['up', 'down', 'across', 'off'] as const) {
        expect(runs[key].seconds, `${preset}: ${key} field time`).toBeCloseTo(reference[key].seconds, 8)
        expect(runs[key].to, `${preset}: ${key} destination`).toEqual(reference[key].to)
      }
      reference ??= runs
      timing[preset] = { switching, east, north, runs, labPaintPerFrame: walk.paint, labUploadPerFrame: walk.upload, labUpdatePerFrame: walk.update, slowFrames: walk.slow, pendingAfter: walk.pending }
      writeFileSync(`${OUT}/timing.json`, JSON.stringify(timing, null, 1))
      for (const name of FEATURES) await shot(page, `${preset}-${name}`, spots.get(name)!)
      await setLook(page, { fog: 'none' })
      await shot(page, `${preset}-fog-off-pass-top`, spots.get('pass-top')!)
      await setLook(page, { fog: 'fog' })
    }
    // Keep round 1's movement regressions: actual movement after both switches.
    // Repeat the preset row at one fixed location after the comparison tour.
    // Pixel caches survive scene restarts; uploads still have to be measured.
    const warm: Record<string, unknown> = {}
    const home = first.spots.find((s) => s.name === 'spawn')!
    await put(page, home)
    await painted(page)
    for (const preset of PRESETS) {
      await startFrames(page)
      await setLook(page, SLOPE_PRESETS[preset].look)
      await painted(page)
      await page.waitForTimeout(250)
      warm[preset] = { frames: await endFrames(page), lab: (await labState(page)).slopes }
    }
    timing.warmSwitchesAtSpawn = warm
    writeFileSync(`${OUT}/timing.json`, JSON.stringify(timing, null, 1))
    await setLook(page, SLOPE_PRESETS.baseline.look)
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    for (const name of ['pass-mid', 'hills', 'gully']) {
      await put(page, spots.get(name)!)
      await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(3, 5))
      const before = (await labState(page)).slopes!.at
      await setLook(page, SLOPE_PRESETS.full.look)
      expect((await labState(page)).slopes!.at).toEqual(before)
      for (let i = 0; i < 8; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, 4))
      const moved = (await labState(page)).slopes!.at
      expect(moved[1]).toBeGreaterThan(before[1])
      await setLook(page, SLOPE_PRESETS.baseline.look)
      expect((await labState(page)).slopes!.at).toEqual(moved)
    }
    await setLook(page, SLOPE_PRESETS.full.look)
    await put(page, spots.get('pass-foot')!)
    const z0 = (await labState(page)).z!
    for (let i = 0; i < 60; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
    expect((await labState(page)).z!).toBeGreaterThan(z0 + 0.5)
    for (const preset of ['baseline', 'full'] as const) {
      await setLook(page, SLOPE_PRESETS[preset].look)
      await put(page, spots.get('steep-band')!)
      for (let i = 0; i < 120; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
      const stopped = await save(page, `${preset}-steep-walk-stopped`)
      expect(stopped.slopes!.tile[1]).toBeGreaterThan(30)
      expect([1, 2]).toContain(stopped.slopes!.kind)
    }
    // Occlusion policy retained; these frames also expose the full-lift cliff joins.
    await shot(page, 'full-behind-plateau', spots.get('behind-plateau')!)
    expect((await labState(page)).slopes!.silhouette).toBe(true)
    await setLook(page, { area: 'mountain' })
    expect((await labState(page)).area).toBe('mountain')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, slopes 2a: moderate lift phone frame', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.moderate.look, grid: false, walkOverlay: false })
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'phone-moderate-pass-mid', spots.get('pass-mid')!)
    await expect(page.getByTestId('height-lab-hud')).toContainText('Slopes, hills and passes')
  })
})
