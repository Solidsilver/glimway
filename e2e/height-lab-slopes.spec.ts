import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { freshPlayer } from './home-helpers'

/**
 * The height lab's slopes round, "Slopes, hills and passes" (dev builds
 * only: `?lab=height`, src/game/height-lab/slopes.ts). Stands at each of the
 * area's features under each drawing style (shading by facing, contour
 * hints, small terraces, the true ¾ lift; the last three with and without
 * shading at a few spots) and saves a screenshot with the HUD hidden, the
 * lab's state beside it, for a person to look at: can you tell uphill from
 * downhill, and walkable from not? They go to .e2e-artifacts/height-lab/slopes/,
 * uploaded with the run's evidence (e2e-full-evidence). The checks: each
 * style builds, switching style keeps the hero on the same ground, and the
 * too-steep band stops a walk north.
 */

const OUT = '.e2e-artifacts/height-lab/slopes'

type Style = 'shade' | 'contours' | 'terraces' | 'lift'
type Look = { area?: 'shoulder' | 'mountain' | 'walk' | 'slopes'; slopeStyle?: Style; slopeShade?: boolean; grid?: boolean }
type Spot = { name: string; x: number; y: number; fx: number; fy: number; note: string }
type Slopes = { style: Style; shade: boolean; lift: boolean; tile: [number, number]; field: { tx: number; ty: number } | null; kind: number; size: [number, number]; spots: Spot[]; parts: number }
type LabState = { area: string; look: Look; built: Look; z?: number; layer?: number; slopes?: Slopes }
type Lab = { put: (layer: number, tx: number, ty: number) => void; step: (dx: number, dy: number) => void; look: (l: Look) => void; state: () => LabState }

const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function openLab(page: Page): Promise<void> {
  await freshPlayer(page)
  await page.goto('/?lab=height')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await page.waitForFunction(() => !!(window as unknown as { __fsLab?: unknown }).__fsLab, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1200)
}

async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate((l) => (window as unknown as { __fsLab: Lab }).__fsLab.look(l), look)
  const rebuilds: (keyof Look)[] = ['area', 'slopeStyle', 'slopeShade']
  try {
    await expect
      .poll(
        async () => {
          const st = await page.evaluate(() => (window as unknown as { __fsLab?: Lab }).__fsLab?.state())
          if (!st) return 'none'
          const done = (Object.keys(look) as (keyof Look)[]).every((k) => (rebuilds.includes(k) ? st.built[k] : st.look[k]) === look[k])
          return done && (st.built.area !== 'slopes' || st.slopes) ? 'ready' : 'waiting'
        },
        { timeout: 60_000 }
      )
      .toBe('ready')
  } catch (e) {
    mkdirSync(OUT, { recursive: true })
    await page.screenshot({ path: `${OUT}/failed-wait.png` })
    writeFileSync(`${OUT}/failed-wait.json`, JSON.stringify(await labState(page).catch(() => null), null, 1))
    throw e
  }
}

const states: Record<string, LabState> = {}

async function hud(page: Page, shown: boolean): Promise<void> {
  await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>('[data-testid="height-lab-hud"]')
    if (el) el.style.visibility = s ? 'visible' : 'hidden'
  }, shown)
}

async function shot(page: Page, name: string, spot: Spot): Promise<LabState> {
  await page.evaluate(([x, y]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, x, y), [spot.x, spot.y] as const)
  await page.waitForTimeout(900)
  const st = await labState(page)
  states[name] = st
  writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
  await page.screenshot({ path: `${OUT}/${name}.png` })
  return st
}

/** Every feature, under every style. */
const FEATURES = ['spawn', 'hills', 'pass-foot', 'pass-mid', 'pass-top', 'steep-band', 'crags', 'spire', 'outcrop-slope', 'outcrop-cliff', 'sea-cliff', 'gully', 'sea', 'plateau', 'around-east']
const STYLES: Style[] = ['shade', 'contours', 'terraces', 'lift']

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes: every feature under every drawing style', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', slopeStyle: 'shade', slopeShade: true, grid: false })
    const first = (await labState(page)).slopes!
    writeFileSync(`${OUT}/spots.json`, JSON.stringify(first.spots, null, 1))
    await hud(page, false)
    for (const style of STYLES) {
      await setLook(page, { slopeStyle: style, slopeShade: true })
      await hud(page, false)
      const st = (await labState(page)).slopes!
      expect(st.style).toBe(style)
      expect(st.lift).toBe(style === 'lift')
      const spots = new Map(st.spots.map((s) => [s.name, s]))
      for (const name of FEATURES) await shot(page, `${style}-${name}`, spots.get(name)!)
    }
    // The styles without shading, at a few spots.
    for (const style of ['contours', 'terraces', 'lift'] as const) {
      await setLook(page, { slopeStyle: style, slopeShade: false })
      await hud(page, false)
      const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
      for (const name of ['hills', 'pass-mid', 'outcrop-slope']) await shot(page, `${style}-noshade-${name}`, spots.get(name)!)
    }
    await setLook(page, { slopeStyle: 'shade', slopeShade: true })
    await hud(page, false)

    // Switching style keeps the hero on the same ground.
    let spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    const mid = spots.get('pass-mid')!
    await shot(page, 'switch-shade', mid)
    const before = (await labState(page)).slopes!.field!
    await setLook(page, { slopeStyle: 'lift' })
    await hud(page, false)
    const after = (await labState(page)).slopes!.field
    expect(after, 'on ground after the switch').not.toBeNull()
    expect(Math.abs(after!.tx - before.tx) + Math.abs(after!.ty - before.ty)).toBeLessThanOrEqual(3)

    // Up the pass in the lift, a few steps at a time.
    spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'lift-climb-0', spots.get('pass-foot')!)
    for (let k = 1; k <= 4; k++) {
      for (let i = 0; i < 10; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
      await page.waitForTimeout(400)
      states[`lift-climb-${k}`] = await labState(page)
      await page.screenshot({ path: `${OUT}/lift-climb-${k}.png` })
    }
    expect(states['lift-climb-4']!.z!).toBeGreaterThan(states['lift-climb-0']!.z! + 0.5)

    // The too-steep band stops a walk north (flat map).
    await setLook(page, { slopeStyle: 'shade' })
    await hud(page, false)
    spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    const band = spots.get('steep-band')!
    await shot(page, 'steep-walk-0', band)
    for (let i = 0; i < 120; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
    await page.waitForTimeout(400)
    const stopped = await labState(page)
    states['steep-walk-1'] = stopped
    await page.screenshot({ path: `${OUT}/steep-walk-1.png` })
    expect(stopped.slopes!.tile[1]).toBeGreaterThan(30)

    // The levels overlay still works here; the HUD shows on one frame.
    await setLook(page, { grid: true })
    await shot(page, 'shade-levels-overlay-pass-mid', mid)
    await setLook(page, { grid: false })
    await hud(page, true)
    await shot(page, 'shade-hud-spawn', spots.get('spawn')!)
    await expect(page.getByTestId('height-lab-hud')).toContainText('Slopes, hills and passes')
    writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
    // The hand-made areas still build after it.
    await setLook(page, { area: 'mountain' })
    expect((await labState(page)).area).toBe('mountain')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, slopes: a phone frame', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', slopeStyle: 'shade', slopeShade: true, grid: false })
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'phone-pass-mid', spots.get('pass-mid')!)
    await expect(page.getByTestId('height-lab-hud')).toContainText('Slopes, hills and passes')
  })
})
