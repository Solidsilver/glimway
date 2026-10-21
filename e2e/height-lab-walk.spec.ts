import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { freshPlayer } from './home-helpers'

/**
 * The height lab's generated area, "Near home" (dev builds only:
 * `?lab=height`, src/game/height-lab/walk.ts; the window is solved by the
 * e2e server's world lab worker, server/internal/worldlab/walk.go). Opens
 * it, then stands at the server's named spots under both strategies (the
 * region plan and per-chunk repair) and saves a screenshot at each, with
 * the lab's state beside it, for a person to look at. They go to
 * .e2e-artifacts/height-lab/walk/, uploaded with the run's evidence
 * (e2e-full-evidence). The checks: the window arrives, the region plan
 * strands nothing, per-chunk repair strands its spot, and switching keeps
 * the hero where they stand.
 */

const OUT = '.e2e-artifacts/height-lab/walk'

type Strategy = 'region' | 'chunk'
type Look = { area?: 'shoulder' | 'mountain' | 'walk'; strategy?: Strategy; walkOverlay?: boolean; grid?: boolean }
type Spot = { name: string; x: number; y: number; note?: string }
type Generated = {
  ready: boolean
  error?: string | null
  strategy?: Strategy
  tile?: [number, number]
  here?: { biome: string; region: string; chunk: [number, number]; world: [number, number]; stranded: boolean } | null
  spots?: Spot[]
  summary?: Record<Strategy, { ramps: number; strandedTiles: number; strandedComponents: number; anchors: string; heldExits: string; solveMs: number }>
  parts?: number
  things?: number
}
type LabState = { area: string; look: Look; built: Look; z?: number; layer?: number; generated?: Generated }
type Lab = { put: (layer: number, tx: number, ty: number) => void; step: (dx: number, dy: number) => void; look: (l: Look) => void; state: () => LabState }

const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function openLab(page: Page): Promise<void> {
  await freshPlayer(page)
  await page.goto('/?lab=height')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await page.waitForFunction(() => !!(window as unknown as { __fsLab?: unknown }).__fsLab, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1200)
}

/** Switch, and wait for a scene built with it (the generated area: built and ready). */
async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate((l) => (window as unknown as { __fsLab: Lab }).__fsLab.look(l), look)
  await expect
    .poll(
      async () => {
        const st = await page.evaluate(() => (window as unknown as { __fsLab?: Lab }).__fsLab?.state())
        if (!st) return 'none'
        if (st.generated?.error) return `error: ${st.generated.error}`
        const built = (Object.keys(look) as (keyof Look)[]).every((k) => st.built[k] === look[k])
        return built && (st.built.area !== 'walk' || st.generated?.ready) ? 'ready' : 'waiting'
      },
      { timeout: 120_000 }
    )
    .toBe('ready')
}

const states: Record<string, LabState> = {}

async function shot(page: Page, name: string, tx: number, ty: number): Promise<LabState> {
  await page.evaluate(([x, y]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(0, x, y), [tx, ty] as const)
  // The camera settles; the chunks round the hero are built.
  await page.waitForTimeout(1200)
  const st = await labState(page)
  states[name] = st
  writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
  await page.screenshot({ path: `${OUT}/${name}.png` })
  return st
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab, near home: both strategies at the named spots', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    const t0 = Date.now()
    await setLook(page, { area: 'walk', strategy: 'region', walkOverlay: false, grid: false })
    const first = await labState(page)
    const g = first.generated!
    writeFileSync(`${OUT}/summary.json`, JSON.stringify({ arrivedMs: Date.now() - t0, summary: g.summary, spots: g.spots }, null, 1))
    expect(g.summary!.region.strandedTiles).toBe(0)
    expect(g.summary!.chunk.strandedTiles).toBeGreaterThan(0)
    const spots = new Map(g.spots!.map((s) => [s.name, s]))
    for (const name of ['home', 'ramp', 'whitequiet']) expect(spots.has(name), name).toBe(true)
    // Spawned at home.
    expect(g.tile).toEqual([spots.get('home')!.x, spots.get('home')!.y])

    for (const strategy of ['region', 'chunk'] as const) {
      await setLook(page, { strategy })
      for (const s of g.spots!) {
        const st = await shot(page, `${strategy}-${s.name}`, s.x, s.y)
        expect(st.generated!.strategy).toBe(strategy)
        if (s.name === 'stranded') expect(st.generated!.here!.stranded, `${strategy} at the stranded spot`).toBe(strategy === 'chunk')
      }
      // The same spots with the overlay: stranded ground magenta, chunk lines.
      await setLook(page, { walkOverlay: true })
      for (const name of ['stranded', 'chunk-ramp', 'ramp']) {
        const s = spots.get(name)
        if (s) await shot(page, `${strategy}-overlay-${name}`, s.x, s.y)
      }
      await setLook(page, { walkOverlay: false })
    }

    // Up the ramp: from its foot toward its top, a few steps at a time.
    await setLook(page, { strategy: 'region' })
    const foot = spots.get('ramp')!
    const top = spots.get('ramp-top') ?? foot
    await shot(page, 'region-ramp-climb-0', foot.x, foot.y)
    const dx = Math.sign(top.x - foot.x) * 4
    const dy = Math.sign(top.y - foot.y) * 4
    for (let k = 1; k <= 4; k++) {
      for (let i = 0; i < 6; i++) await page.evaluate(([x, y]) => (window as unknown as { __fsLab: Lab }).__fsLab.step(x, y), [dx, dy] as const)
      await page.waitForTimeout(400)
      const st = await labState(page)
      states[`region-ramp-climb-${k}`] = st
      await page.screenshot({ path: `${OUT}/region-ramp-climb-${k}.png` })
    }
    writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
    expect(states['region-ramp-climb-4']!.z!).toBeGreaterThan(states['region-ramp-climb-0']!.z! + 0.2)

    // Switching keeps the hero where they stand when it's floor under both.
    const home = spots.get('home')!
    await shot(page, 'region-home-again', home.x + 3, home.y - 2)
    await setLook(page, { strategy: 'chunk' })
    expect((await labState(page)).generated!.tile).toEqual([home.x + 3, home.y - 2])
    // The levels overlay still works here.
    await setLook(page, { grid: true })
    await shot(page, 'chunk-levels-overlay-chunk-ramp', spots.get('chunk-ramp')?.x ?? home.x, spots.get('chunk-ramp')?.y ?? home.y)
    await setLook(page, { grid: false, strategy: 'region' })
    // And the hand-made areas still build after it.
    await setLook(page, { area: 'shoulder' })
    expect((await labState(page)).area).toBe('shoulder')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('height lab, near home: the HUD line on a phone', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'walk', strategy: 'region', walkOverlay: false, grid: false })
    const st = await labState(page)
    const home = st.generated!.spots!.find((s) => s.name === 'home')!
    await shot(page, 'phone-home', home.x, home.y)
    await expect(page.getByTestId('height-lab-hud')).toContainText('Near home — Region plan')
  })
})
