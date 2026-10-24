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
  await sunReady(page)
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
    lab.look({ slopeUphill: 0 })
    at(86 * 16, 96.5 * 16 + 2)
    const off = lab.run(0, -1, 56)
    lab.look({ slopeUphill: 12 })
    return { up, down, across, off }
  })
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2a: five presets, matching frames and timing tails', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.full.look, slopeUphill: 12, slopeDownhill: 0, sunlight: false, grid: false, walkOverlay: false, fog: 'fog', fogStrength: 'medium', zoom: true, haze: true })
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

test.describe('slopes 2b', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2b: sun pairs, speed sliders, gait and frame tails', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.baseline.look, slopeUphill: 12, slopeDownhill: 0, slopeGait: true, sunlight: false, sunStrength: 1, grid: false, walkOverlay: false, fog: 'fog', fogStrength: 'medium', zoom: true, haze: true })
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    const sunny: Spot = { name: 'knoll-sunny', x: 82, y: 87, fx: 82, fy: 87, look: null }
    const shaded: Spot = { name: 'knoll-shaded', x: 90, y: 95, fx: 90, fy: 95, look: null }
    // The gentle approach keeps the hero and cast shadow central; the cliff-foot
    // reference camera puts the feet against the bottom edge of the frame.
    const features = [spots.get('hills')!, sunny, shaded, spots.get('pass-top')!, spots.get('outcrop-slope')!, spots.get('rocky-path')!]
    const timing: Record<string, unknown> = {}
    for (const sunlight of [false, true]) {
      await startFrames(page)
      await setLook(page, { sunlight })
      await painted(page)
      const switching = await endFrames(page)
      const states: Record<string, LabState> = {}
      for (const spot of features) states[spot.name] = await shot(page, `2b-${sunlight ? 'on' : 'off'}-${spot.name}`, spot)
      await put(page, spots.get('spawn')!)
      await painted(page)
      const east = await walkTimed(page, 'ArrowRight', 4000)
      const north = await walkTimed(page, 'ArrowUp', 3000)
      timing[sunlight ? 'on' : 'off'] = { switching, east, north, states, lab: (await labState(page)).slopes }
      writeFileSync(`${OUT}/2b-timing.json`, JSON.stringify(timing, null, 1))
    }
    // All drawing presets and both sun states retain the same field travel.
    const runs: Record<string, unknown> = {}
    const refs = new Map<string, { up: Run; down: Run; across: Run }>()
    for (const preset of PRESETS) {
      await setLook(page, SLOPE_PRESETS[preset].look)
      for (const [uphill, downhill] of [[0, 0], [12, 0], [24, 6], [40, 20], [60, 6], [80, 20]]) {
        await setLook(page, { slopeUphill: uphill, slopeDownhill: downhill })
        const sample = await page.evaluate(() => {
          const lab = (window as unknown as { __fsLab: Lab }).__fsLab
          const at = (x: number, y: number) => lab.put(0, (x - 8) / 16, (y - 12) / 16)
          at(86 * 16, 96.5 * 16 + 2)
          const up = lab.run(0, -1, 56)
          const down = lab.run(0, 1, 56)
          at(91 * 16, 91 * 16 + 2)
          const across = lab.run(0, -1, 32)
          return { up, down, across }
        })
        for (const r of Object.values(sample)) expect(r.blocked).toBe(false)
        const key = `${uphill}/${downhill}`
        const ref = refs.get(key)
        if (ref) for (const dir of ['up', 'down', 'across'] as const) expect(sample[dir].seconds).toBeCloseTo(ref[dir].seconds, 8)
        refs.set(key, sample)
        runs[`${preset}-${key}`] = sample
      }
    }
    expect(refs.get('40/20')!.up.seconds).toBeGreaterThan(refs.get('12/0')!.up.seconds)
    expect(refs.get('40/20')!.down.seconds).toBeLessThan(refs.get('12/0')!.down.seconds)
    timing.runs = runs
    await setLook(page, { ...SLOPE_PRESETS.baseline.look, slopeUphill: 40, slopeDownhill: 20 })
    // Read actual moving gait before releasing each real key; blocked and idle
    // movement cannot invent a cadence. Browser frame samples above use real keys too.
    const gait: unknown[] = []
    for (const [ty, key] of [[96.5, 'ArrowUp'], [93, 'ArrowDown']] as const) {
      await page.evaluate((y) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, 85.5, y - 0.625), ty)
      await painted(page)
      await page.keyboard.down(key)
      await page.waitForTimeout(350)
      const st = await labState(page)
      gait.push(st)
      const g = (st.slopes as Slopes & { sunlight: { gait: { cadence: number } } }).sunlight.gait
      expect(g.cadence).toBeGreaterThan(0)
      if (key === 'ArrowUp') expect(g.cadence).toBeLessThan(0.8)
      else expect(g.cadence).toBeGreaterThan(1.1)
      await page.keyboard.up(key)
    }
    timing.gait = gait
    writeFileSync(`${OUT}/2b-timing.json`, JSON.stringify(timing, null, 1))
  })
})

test.describe('slopes 2b phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, slopes 2b: sunlight phone frame', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.baseline.look, sunlight: true, sunStrength: 1, slopeGait: true, slopeUphill: 12, slopeDownhill: 0, grid: false, walkOverlay: false })
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, '2b-phone-on-hills', spots.get('hills')!)
  })
})

// Round 2c: same camera positions through the sun arc; no local Vite/Playwright.
type SunSlopes = Slopes & {
  sunMap: { pending: number; revision: string; costs: number[]; albedoPaints: number }
  sunlight: { direction: number[]; time: number; daylight: number; visibility: number; opacity: number; shadow: { dx: number; dy: number; length: number } }
}
const sunState = async (page: Page) => (await labState(page)).slopes as SunSlopes
async function sunReady(page: Page) {
  await expect.poll(async () => (await sunState(page))?.sunMap?.pending ?? 0, { timeout: 60_000 }).toBe(0)
}
async function speedRuns(page: Page) {
  return page.evaluate(() => {
    const lab = (window as unknown as { __fsLab: Lab }).__fsLab
    lab.put(0, 85.5, 96.5 - .625)
    const up = lab.run(0, -1, 56)
    const down = lab.run(0, 1, 56)
    return { up, down }
  })
}

test.describe('slopes 2c', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2c: one sun arc, matching frames, lazy light and linear speed', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.baseline.look, slopeUphill: 60, slopeDownhill: 6, sunlight: true, sunStrength: 1, sunTime: .5, sunClock: false, grid: false, walkOverlay: false, fog: 'fog', fogStrength: 'medium', zoom: true, haze: true })
    const spots = new Map((await labState(page)).slopes!.spots.map(s => [s.name, s]))
    const owner = { ...spots.get('pass-mid')!, look: null }
    const frames: Record<string, LabState> = {}
    const facing: Record<string, SunSlopes['sunlight']> = {}
    for (const [name, time] of [['morning', .1], ['noon', .5], ['evening', .9]] as const) {
      await setLook(page, { sunTime: time })
      frames[`owner-${name}`] = await shot(page, `2c-owner-${name}`, owner)
      facing[name] = (await sunState(page)).sunlight
      if (name !== 'noon') for (const feature of ['hills', 'outcrop-slope']) frames[`${feature}-${name}`] = await shot(page, `2c-${feature}-${name}`, spots.get(feature)!)
    }
    await setLook(page, { sunTime: .5 })
    for (const [name, x, y] of [['sunny', 86, 87], ['shaded', 86, 96]] as const) {
      frames[`knoll-${name}-noon`] = await shot(page, `2c-knoll-${name}-noon`, { name, x, y, fx: x, fy: y, look: null })
    }
    await setLook(page, { sunTime: .9 })
    frames['spire-evening'] = await shot(page, '2c-spire-evening', spots.get('spire')!)
    const terrainShade = { name: 'terrain-shade', x: 69, y: 34, fx: 69, fy: 34, look: null }
    // 2d's arc is lower at 7.2 h, so this spot's morning sun comes at 8.4 h.
    for (const [name, time] of [['morning', .2], ['evening', .9]] as const) {
      await setLook(page, { sunTime: time })
      frames[`terrain-shade-${name}`] = await shot(page, `2c-terrain-shade-${name}`, terrainShade)
    }
    const shade = frames['terrain-shade-evening'].slopes as SunSlopes
    expect(shade.sunlight.visibility).toBeLessThan(.15)
    expect(shade.sunlight.opacity).toBeLessThan(.07)
    expect((frames['terrain-shade-morning'].slopes as SunSlopes).sunlight.visibility).toBeGreaterThan(.85)
    await put(page, owner)
    await painted(page); await sunReady(page)
    expect(facing.morning.direction[0]).toBeGreaterThan(0)
    expect(facing.evening.direction[0]).toBeLessThan(0)
    for (const s of Object.values(facing)) expect(s.shadow.dx * s.direction[0] + s.shadow.dy * s.direction[1]).toBeLessThan(0)
    // Scrub repeatedly while stationary. Texture paint count must stay fixed.
    const before = await sunState(page)
    await startFrames(page)
    for (let i = 0; i <= 40; i++) {
      await setLook(page, { sunTime: i / 40 })
      await page.waitForTimeout(80)
    }
    const scrubbing = await endFrames(page)
    await sunReady(page)
    const after = await sunState(page)
    expect(after.sunMap.albedoPaints).toBe(before.sunMap.albedoPaints)
    expect(after.at).toEqual(before.at)
    const runs: Record<string, unknown> = {}
    for (const [up, down] of [[0, 0], [40, 6], [60, 6], [80, 20]]) {
      await setLook(page, { slopeUphill: up, slopeDownhill: down })
      const result = await speedRuns(page)
      expect(result.up.blocked).toBe(false); expect(result.down.blocked).toBe(false)
      runs[`${up}/${down}`] = result
    }
    // Existing clock hook supplies the same game clock as the dev offset.
    const setClock = (hour: number | null) => page.evaluate((h) => {
      const lab = (window as unknown as { __fsLab: Lab & { clock: (u: number | null) => void } }).__fsLab
      lab.clock(h === null ? null : 1_800_000_000 - 1_800_000_000 % 86400 + h * 3600)
    }, hour)
    await setLook(page, { sunClock: true })
    await setClock(0); await page.waitForTimeout(100); await sunReady(page)
    expect((await sunState(page)).sunlight.daylight).toBe(0)
    await setClock(12); await page.waitForTimeout(100); await sunReady(page)
    expect((await sunState(page)).sunlight.time).toBeCloseTo(.5, 2)
    expect((await sunState(page)).sunlight.daylight).toBe(1)
    await setClock(null)
    await setLook(page, { sunClock: false, sunTime: .5 })
    writeFileSync(`${OUT}/2c-evidence.json`, JSON.stringify({ frames, facing, scrubbing, lightCostsPerChunk: after.sunMap.costs, runs, before: before.sunMap, after: after.sunMap }, null, 1))
    expect(scrubbing.p95, 'time scrubbing frame p95').toBeLessThan(50)
  })
})

test.describe('slopes 2c phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, slopes 2c: one sun phone frame', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', ...SLOPE_PRESETS.baseline.look, sunlight: true, sunStrength: 1, sunTime: .1, sunClock: false, slopeUphill: 60, slopeDownhill: 6, grid: false, walkOverlay: false })
    const spots = new Map((await labState(page)).slopes!.spots.map(s => [s.name, s]))
    await shot(page, '2c-phone-owner-morning', { ...spots.get('pass-mid')!, look: null })
  })
})

// Round 2d: proxy shadows. The owner's meadow time sweep, shade, spire, phone. CI only.
type ShadowSlopes = SunSlopes & { sunlight: SunSlopes['sunlight'] & {
  mode: string; ray: number[]; under: number; cast: { x0: number; y0: number; w: number; h: number; foot: number[] }
  casters: { x: number; y: number; kind: string; foot: number[]; height: number; v: number[]; visible: number }[] } }
const SWEEP = [9.6, 10.6, 11.3, 11.6, 11.9, 12.2, 12.5, 13.7, 16.8]
const hourTime = (h: number) => Math.round((h - 6) / 12 * 1000) / 1000
/** A crop around the hero (the camera follows them) to judge shadows at full size. */
async function crop(page: Page, name: string) {
  const vp = page.viewportSize()!
  const w = Math.min(560, vp.width), h = Math.min(360, vp.height)
  await page.screenshot({ path: `${OUT}/${name}-crop.png`, clip: { x: (vp.width - w) / 2, y: (vp.height - h) / 2, width: w, height: h } })
}
const SHADOW_LOOK: Look = { area: 'slopes', ...SLOPE_PRESETS.baseline.look, slopeUphill: 60, slopeDownhill: 6, sunlight: true, sunStrength: 1, sunTime: .5, sunClock: false, spriteShadows: 'proxy', grid: false, walkOverlay: false, fog: 'fog', fogStrength: 'medium', zoom: true, haze: true }

test.describe('slopes 2d', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2d: proxy shadows through the day at the meadow, in shade and at the spire', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, SHADOW_LOOK)
    const spots = new Map((await labState(page)).slopes!.spots.map(s => [s.name, s]))
    // The meadow: a boulder at 87,73 among pines, a birch at 87,78; the hero just south-west of the rock.
    const meadow: Spot = { name: 'meadow', x: 86, y: 75, fx: 86, fy: 75, look: null }
    const hills: Spot = { name: 'hills-meadow', x: 26, y: 81, fx: 26, fy: 81, look: null }
    const frames: Record<string, ShadowSlopes['sunlight']> = {}
    for (const h of SWEEP) {
      await setLook(page, { sunTime: hourTime(h) })
      const name = `2d-meadow-${h.toFixed(1)}h`
      frames[name] = ((await shot(page, name, meadow)).slopes as ShadowSlopes).sunlight
      await crop(page, name)
    }
    // The same meadow drawn the 2c way, to compare.
    for (const h of [11.6, 16.8]) {
      await setLook(page, { sunTime: hourTime(h), spriteShadows: 'silhouette' })
      const name = `2d-meadow-${h.toFixed(1)}h-2c-silhouette`
      frames[name] = ((await shot(page, name, meadow)).slopes as ShadowSlopes).sunlight
      await crop(page, name)
    }
    await setLook(page, { spriteShadows: 'proxy' })
    for (const h of [9.6, 12, 16.8]) {
      await setLook(page, { sunTime: hourTime(h) })
      const name = `2d-hills-meadow-${h.toFixed(1)}h`
      frames[name] = ((await shot(page, name, hills)).slopes as ShadowSlopes).sunlight
      await crop(page, name)
    }
    // The knoll's shaded and sunny sides at noon; the spire's long evening shade.
    await setLook(page, { sunTime: .5 })
    for (const [name, x, y] of [['sunny', 86, 87], ['shaded', 86, 96]] as const) {
      frames[`2d-knoll-${name}-noon`] = ((await shot(page, `2d-knoll-${name}-noon`, { name, x, y, fx: x, fy: y, look: null })).slopes as ShadowSlopes).sunlight
      await crop(page, `2d-knoll-${name}-noon`)
    }
    await setLook(page, { sunTime: hourTime(16.8) })
    frames['2d-spire-evening'] = ((await shot(page, '2d-spire-evening', spots.get('spire')!)).slopes as ShadowSlopes).sunlight
    await crop(page, '2d-spire-evening')
    // In terrain shade the hero's directional shadow fades; contact remains.
    const terrainShade: Spot = { name: 'terrain-shade', x: 69, y: 34, fx: 69, fy: 34, look: null }
    for (const [name, h] of [['morning', 7.2], ['evening', 16.8]] as const) {
      await setLook(page, { sunTime: hourTime(h) })
      frames[`2d-terrain-shade-${name}`] = ((await shot(page, `2d-terrain-shade-${name}`, terrainShade)).slopes as ShadowSlopes).sunlight
      await crop(page, `2d-terrain-shade-${name}`)
    }
    // Scrubbing stays smooth with still shadows redrawn per chunk.
    await setLook(page, { sunTime: .5 })
    await put(page, meadow); await painted(page); await sunReady(page)
    const before = await sunState(page)
    await startFrames(page)
    for (let i = 0; i <= 40; i++) {
      await setLook(page, { sunTime: i / 40 })
      await page.waitForTimeout(80)
    }
    const scrubbing = await endFrames(page)
    await sunReady(page)
    const after = await sunState(page)
    writeFileSync(`${OUT}/2d-evidence.json`, JSON.stringify({ frames, scrubbing, lightCostsPerChunk: after.sunMap.costs, before: before.sunMap, after: after.sunMap }, null, 1))
    expect(after.sunMap.albedoPaints).toBe(before.sunMap.albedoPaints)
    // The noon sweep turns gently: 11.3 → 12.5 h moves the ray under 25°.
    const angle = (s: ShadowSlopes['sunlight']) => Math.atan2(s.ray[1]!, s.ray[0]!) * 180 / Math.PI
    expect(Math.abs(angle(frames['2d-meadow-12.5h']!) - angle(frames['2d-meadow-11.3h']!))).toBeLessThan(25)
    const len = (s: ShadowSlopes['sunlight']) => Math.hypot(s.ray[0]!, s.ray[1]!)
    expect(len(frames['2d-meadow-12.2h']!)).toBeLessThan(.6)
    expect(len(frames['2d-meadow-16.8h']!)).toBeGreaterThan(2)
    for (const [name, s] of Object.entries(frames)) {
      expect(s.mode, name).toBe(name.includes('2c-silhouette') ? 'silhouette' : 'proxy')
      // The hero's footprint lies inside their own cast box.
      if (s.mode === 'proxy') {
        expect(s.cast.foot[0]! >= s.cast.x0 && s.cast.foot[0]! <= s.cast.x0 + s.cast.w, name).toBe(true)
        expect(s.cast.foot[1]! >= s.cast.y0 && s.cast.foot[1]! <= s.cast.y0 + s.cast.h, name).toBe(true)
      }
    }
    expect(frames['2d-meadow-12.2h']!.casters.some(c => c.kind === 'rock')).toBe(true)
    expect(frames['2d-meadow-12.2h']!.casters.some(c => c.kind === 'tree')).toBe(true)
    expect(scrubbing.p95, 'time scrubbing frame p95').toBeLessThan(50)
  })
})

test.describe('slopes 2d phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, slopes 2d: proxy shadows phone frame', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { ...SHADOW_LOOK, sunTime: hourTime(9.6) })
    await shot(page, '2d-phone-meadow-9.6h', { name: 'meadow', x: 86, y: 75, fx: 86, fy: 75, look: null })
  })
})

// Round 2e: edge shading and partial see-through. The owner's spiral ramp in the lift and in
// shading by facing, each with edges off / default / strong and scaled or not; a gentle meadow and a
// cliff edge with the defaults; the hero with only the legs behind the plateau's rim, and fully behind. CI only.
type EdgeSlopes = ShadowSlopes & {
  cover: { box: number[]; covered: number; total: number; spriteCovered: number; spriteTotal: number; top: number }
  edges: { settings: { strength: number; width: number; scale: boolean; threshold: number; rim: boolean }; chunks: number; edges: number }
}
const EDGE_DEFAULTS: Look = { edgeShade: .6, edgeWidth: 3, edgeScale: true, edgeThreshold: .5, edgeRim: true }
const EDGE_VARIANTS: [string, Look][] = [
  ['off', { ...EDGE_DEFAULTS, edgeShade: 0 }],
  ['default', EDGE_DEFAULTS],
  ['strong', { ...EDGE_DEFAULTS, edgeShade: 1 }],
  ['default-unscaled', { ...EDGE_DEFAULTS, edgeScale: false }],
  ['strong-unscaled', { ...EDGE_DEFAULTS, edgeShade: 1, edgeScale: false }]
]
/** The owner's screenshot: restrained facing, contours off, 7.8 h. */
const OWNER_LOOK: Look = { ...SHADOW_LOOK, sunTime: hourTime(7.8), ...EDGE_DEFAULTS }

test.describe('slopes 2e', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes 2e: edge shading at the spiral ramp in two looks, and partial see-through', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, OWNER_LOOK)
    const spots = new Map((await labState(page)).slopes!.spots.map(s => [s.name, s]))
    const ramp = spots.get('spiral-ramp')!
    const frames: Record<string, { edges: EdgeSlopes['edges']; cover: EdgeSlopes['cover']; silhouette: boolean; tile: number[] }> = {}
    const keep = async (name: string, spot: Spot, cropToo = true) => {
      const st = (await shot(page, name, spot)).slopes as EdgeSlopes
      frames[name] = { edges: st.edges, cover: st.cover, silhouette: st.silhouette, tile: st.tile }
      if (cropToo) await crop(page, name)
      return st
    }
    for (const [look, lift] of [['lift', 48], ['facing', 0]] as const) {
      await setLook(page, { slopeLift: lift })
      for (const [variant, edges] of EDGE_VARIANTS) {
        await setLook(page, edges)
        await keep(`2e-ramp-${look}-${variant}`, ramp)
      }
      await setLook(page, EDGE_DEFAULTS)
      // Gentle hills stay clean; a cliff's edge reads.
      await keep(`2e-hills-meadow-${look}`, spots.get('hills')!)
      await keep(`2e-cliff-edge-${look}`, spots.get('outcrop-top')!)
    }
    // Partial see-through: legs behind the plateau's rim, then fully behind it; and at 24 px a level.
    await setLook(page, { slopeLift: 48 })
    const legs = await keep('2e-seethrough-legs-48', spots.get('legs-behind-ridge')!)
    const full = await keep('2e-seethrough-full-48', spots.get('behind-plateau')!)
    await setLook(page, { slopeLift: 24 })
    const legs24 = await keep('2e-seethrough-legs-24', spots.get('behind-plateau')!)
    writeFileSync(`${OUT}/2e-evidence.json`, JSON.stringify(frames, null, 1))
    expect(legs.cover.spriteCovered, 'legs: some covered').toBeGreaterThan(0)
    expect(legs.cover.spriteCovered, 'legs: not all covered').toBeLessThan(legs.cover.spriteTotal * .8)
    expect(legs.cover.top, 'legs: covered from below the head').toBeGreaterThan(4)
    expect(full.cover.spriteCovered, 'full: all covered').toBeGreaterThanOrEqual(full.cover.spriteTotal * .95)
    expect(legs24.cover.spriteCovered).toBeGreaterThan(0)
    expect(legs24.cover.spriteCovered).toBeLessThan(legs24.cover.spriteTotal)
    for (const [name, f] of Object.entries(frames)) {
      if (!name.startsWith('2e-ramp')) continue
      if (name.endsWith('-off')) expect(f.edges.settings.strength, name).toBe(0)
      else expect(f.edges.edges, name).toBeGreaterThan(0)
    }
  })
})
