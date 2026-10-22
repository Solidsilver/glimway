import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { freshPlayer } from './home-helpers'

/**
 * The height lab's slopes round, "Slopes, hills and passes" (dev builds
 * only: `?lab=height`, src/game/height-lab/slopes.ts). Every style walks the
 * same field; a style only changes the drawing. The spec:
 *  - walks north from spawn for a few seconds in shading and in the lift
 *    (chunks not yet painted in that style), recording frame intervals and
 *    the lab's paint/update times per frame (timing.json);
 *  - stands at each feature under each drawing style (the last three with
 *    and without shading at a few spots) and saves a screenshot with the
 *    HUD hidden, the lab's state beside it;
 *  - checks switching style never moves the hero, and moves still work
 *    after it, both ways;
 *  - walks up the pass and along the steep band in the lift, and stands
 *    behind the plateau patch (drawn as a silhouette).
 * Frames go to .e2e-artifacts/height-lab/slopes/ (e2e-full-evidence).
 */

const OUT = '.e2e-artifacts/height-lab/slopes'

type Style = 'shade' | 'contours' | 'terraces' | 'lift'
type Look = { area?: 'shoulder' | 'mountain' | 'walk' | 'slopes'; slopeStyle?: Style; slopeShade?: boolean; grid?: boolean }
type Spot = { name: string; x: number; y: number; fx: number; fy: number; note: string; look: [number, number] | null }
type Times = { frames: number; p50: number; p95: number; max: number }
type Slopes = { style: Style; shade: boolean; lift: boolean; tile: [number, number]; at: [number, number]; shown: [number, number]; silhouette: boolean; kind: number; size: [number, number]; pending: number; paint: Times; update: Times; spots: Spot[] }
type LabState = { area: string; look: Look; built: Look; z?: number; layer?: number; slopes?: Slopes }
type Lab = { put: (layer: number, tx: number, ty: number, look?: [number, number]) => void; step: (dx: number, dy: number) => void; look: (l: Look) => void; state: () => LabState }

const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function openLab(page: Page): Promise<void> {
  await freshPlayer(page)
  await page.goto('/?lab=height')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await page.waitForFunction(() => !!(window as unknown as { __fsLab?: unknown }).__fsLab, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1200)
}

/** Until every chunk round the view is painted (the slopes area paints a step a frame). */
async function painted(page: Page): Promise<void> {
  await expect.poll(async () => (await labState(page)).slopes?.pending ?? 0, { timeout: 60_000 }).toBe(0)
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

async function save(page: Page, name: string): Promise<LabState> {
  const st = await labState(page)
  states[name] = st
  writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
  await page.screenshot({ path: `${OUT}/${name}.png` })
  return st
}

/** Stand at a spot (field tile; framed on its feature when it has one), wait for the paint, shoot. */
async function shot(page: Page, name: string, spot: Spot): Promise<LabState> {
  await page.evaluate(([x, y, look]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, x, y, look ?? undefined), [spot.x, spot.y, spot.look] as const)
  await painted(page)
  await page.waitForTimeout(500)
  return save(page, name)
}

/** Hold a key for a while, recording frame intervals (ms) in the page. */
async function walkTimed(page: Page, key: string, ms: number): Promise<{ frames: number; p50: number; p95: number; max: number; over33: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames?: number[]; __framesOn?: boolean }
    w.__frames = []
    w.__framesOn = true
    let last = performance.now()
    const tick = (t: number) => {
      w.__frames!.push(t - last)
      last = t
      if (w.__framesOn) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  const f = await page.evaluate(() => {
    const w = window as unknown as { __frames?: number[]; __framesOn?: boolean }
    w.__framesOn = false
    return w.__frames!.slice(1)
  })
  const s = [...f].sort((a, b) => a - b)
  return { frames: s.length, p50: s[s.length >> 1] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s.at(-1) ?? 0, over33: s.filter((x) => x > 33).length }
}

/** Every feature, under every style. */
const FEATURES = ['spawn', 'hills', 'pass-foot', 'pass-mid', 'pass-top', 'steep-band', 'crags', 'spire', 'outcrop-slope', 'outcrop-cliff', 'sea-cliff', 'gully', 'sea', 'plateau', 'around-east', 'behind-plateau']
const STYLES: Style[] = ['shade', 'contours', 'terraces', 'lift']

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, slopes: every feature under every drawing style', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'slopes', slopeStyle: 'shade', slopeShade: true, grid: false })
    await painted(page)
    const first = (await labState(page)).slopes!
    writeFileSync(`${OUT}/spots.json`, JSON.stringify(first.spots, null, 1))
    await hud(page, false)

    // Walking into chunks not yet painted: frame times, in shading and in the lift.
    const timing: Record<string, unknown> = {}
    for (const style of ['shade', 'lift'] as const) {
      await setLook(page, { slopeStyle: style })
      await hud(page, false)
      const spawn = (await labState(page)).slopes!.spots.find((s) => s.name === 'spawn')!
      await page.evaluate(([x, y]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, x, y), [spawn.x, spawn.y] as const)
      await painted(page)
      // Away to the east first (along the valley), then north up the pass's foot: new chunks either way.
      const east = await walkTimed(page, 'ArrowRight', 4000)
      const north = await walkTimed(page, 'ArrowUp', 3000)
      const st = (await labState(page)).slopes!
      timing[style] = { east, north, labPaintPerFrame: st.paint, labUpdatePerFrame: st.update, pendingAfter: st.pending }
      writeFileSync(`${OUT}/timing.json`, JSON.stringify(timing, null, 1))
    }

    for (const style of STYLES) {
      await setLook(page, { slopeStyle: style, slopeShade: true })
      await hud(page, false)
      const st = (await labState(page)).slopes!
      expect(st.style).toBe(style)
      expect(st.lift).toBe(style === 'lift')
      const spots = new Map(st.spots.map((s) => [s.name, s]))
      for (const name of FEATURES) await shot(page, `${style}-${name}`, spots.get(name)!)
    }
    // Behind the plateau patch in the lift: a silhouette.
    expect(states['lift-behind-plateau']!.slopes!.silhouette).toBe(true)
    expect(states['shade-behind-plateau']!.slopes!.silhouette).toBe(false)
    // The styles without shading, at a few spots.
    for (const style of ['contours', 'terraces', 'lift'] as const) {
      await setLook(page, { slopeStyle: style, slopeShade: false })
      await hud(page, false)
      const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
      for (const name of ['hills', 'pass-mid', 'outcrop-slope']) await shot(page, `${style}-noshade-${name}`, spots.get(name)!)
    }
    await setLook(page, { slopeStyle: 'shade', slopeShade: true })
    await hud(page, false)

    // Switching style never moves the hero, either way; moves work after it.
    let spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    for (const name of ['pass-mid', 'hills', 'gully']) {
      await shot(page, `switch-${name}-shade`, spots.get(name)!)
      await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(3, 5))
      const before = (await labState(page)).slopes!.at
      await setLook(page, { slopeStyle: 'lift' })
      const lifted = (await labState(page)).slopes!
      expect(lifted.at, `${name}: shading → lift`).toEqual(before)
      for (let i = 0; i < 8; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, 4))
      const moved = (await labState(page)).slopes!.at
      expect(moved[1], `${name}: moves after the switch`).toBeGreaterThan(before[1])
      await setLook(page, { slopeStyle: 'shade' })
      expect((await labState(page)).slopes!.at, `${name}: lift → shading`).toEqual(moved)
    }

    // Walking in the lift: up the pass, a few steps at a time; then north into the steep band.
    await setLook(page, { slopeStyle: 'lift' })
    await hud(page, false)
    spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'lift-climb-0', spots.get('pass-foot')!)
    for (let k = 1; k <= 5; k++) {
      for (let i = 0; i < 12; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
      await painted(page)
      await page.waitForTimeout(300)
      await save(page, `lift-climb-${k}`)
    }
    expect(states['lift-climb-5']!.z!).toBeGreaterThan(states['lift-climb-0']!.z! + 0.5)
    await shot(page, 'lift-steep-walk-0', spots.get('steep-band')!)
    for (let i = 0; i < 120; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
    await painted(page)
    const stoppedLift = await save(page, 'lift-steep-walk-1')
    expect(stoppedLift.slopes!.tile[1]).toBeGreaterThan(30)
    // Along the steep band's foot, east, in the lift.
    for (let i = 0; i < 60; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(6, 0))
    await painted(page)
    const along = await save(page, 'lift-steep-walk-2')
    expect(along.slopes!.kind === 2 || along.slopes!.kind === 1, 'still on walkable ground').toBe(true)

    // The too-steep band stops a walk north (shading).
    await setLook(page, { slopeStyle: 'shade' })
    await hud(page, false)
    spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'steep-walk-0', spots.get('steep-band')!)
    for (let i = 0; i < 120; i++) await page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.step(0, -6))
    const stopped = await save(page, 'steep-walk-1')
    expect(stopped.slopes!.tile[1]).toBeGreaterThan(30)

    // The levels overlay still works here; the HUD shows on one frame.
    await setLook(page, { grid: true })
    await shot(page, 'shade-levels-overlay-pass-mid', spots.get('pass-mid')!)
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
    await setLook(page, { area: 'slopes', slopeStyle: 'lift', slopeShade: true, grid: false })
    const spots = new Map((await labState(page)).slopes!.spots.map((s) => [s.name, s]))
    await shot(page, 'phone-pass-mid', spots.get('pass-mid')!)
    await expect(page.getByTestId('height-lab-hud')).toContainText('Slopes, hills and passes')
  })
})
