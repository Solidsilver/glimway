import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Page } from './fixtures'
import { freshPlayer } from './home-helpers'

/**
 * The height lab's light, seen (dev builds only: `?lab=height`,
 * src/game/height-lab). Puts the hero at set spots in each area, with
 * their own light close or none, and saves a screenshot at each, with the
 * lab's state beside it. Not a pass/fail check of the picture: the images
 * are for a person to look at. They go to .e2e-artifacts/height-lab/, which
 * CI uploads with the run's evidence (e2e-full-evidence), so a lane can
 * `gh run download` them. Runs whenever src/game/height-lab changes
 * (e2e/changed-map.json).
 */

const OUT = '.e2e-artifacts/height-lab'
const CAVE = 1
const SURFACE = 0

type Look = { area?: 'shoulder' | 'mountain'; cave?: 'lantern' | 'wide' | 'dim' }
type LabState = { area: string; layer: number; z: number; sky: number; cave: number; light: number; lightMs: number }
type Lab = { put: (layer: number, tx: number, ty: number) => void; look: (l: Look) => void; state: () => LabState }

const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate((l) => (window as unknown as { __fsLab: Lab }).__fsLab.look(l), look)
  if (look.area) await expect.poll(() => page.evaluate(() => (window as unknown as { __fsLab?: Lab }).__fsLab?.state().area), { timeout: 30_000 }).toBe(look.area)
}

const states: Record<string, LabState> = {}

async function shot(page: Page, name: string, layer: number, tx: number, ty: number): Promise<void> {
  await page.evaluate(([ly, x, y]) => (window as unknown as { __fsLab: Lab }).__fsLab.put(ly, x, y), [layer, tx, ty] as const)
  // The camera settles; the light is redrawn every frame.
  await page.waitForTimeout(900)
  states[name] = await labState(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

async function openLab(page: Page): Promise<void> {
  await freshPlayer(page)
  await page.goto('/?lab=height')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await page.waitForFunction(() => !!(window as unknown as { __fsLab?: unknown }).__fsLab, undefined, { timeout: 60_000 })
  // Past the scene's fade-in.
  await page.waitForTimeout(1200)
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })
  test('height lab: cave light at set spots', async ({ page }) => {
    test.setTimeout(240_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)

    // The mountain: in through the east mouth (cols 56–57, arch rows 72–73), down to the cavern.
    await setLook(page, { area: 'mountain', cave: 'lantern' })
    await shot(page, 'm01-approach', SURFACE, 56, 77)
    await shot(page, 'm02-arch', CAVE, 56, 73)
    await shot(page, 'm03-one-in', CAVE, 56, 72)
    await shot(page, 'm04-two-in', CAVE, 56, 71)
    await shot(page, 'm05-three-in', CAVE, 56, 70)
    await shot(page, 'm06-five-in', CAVE, 56, 68)
    await shot(page, 'm07-mid-tunnel', CAVE, 56, 63)
    await shot(page, 'm09-ledge', CAVE, 44, 31)
    await shot(page, 'm10-cavern', CAVE, 42, 44)
    await shot(page, 'm11-two-crystals-overlap', CAVE, 45, 47)
    await shot(page, 'm12-west-tunnel-looking-out', CAVE, 41, 69)
    await setLook(page, { cave: 'dim' })
    await shot(page, 'm08-none-crystal-in-corridor', CAVE, 64, 59)
    await shot(page, 'm13-none-mid-tunnel', CAVE, 56, 63)
    await shot(page, 'm14-none-cavern', CAVE, 42, 44)
    await shot(page, 'm15-none-corridor', CAVE, 75, 34)
    await setLook(page, { cave: 'lantern' })
    await shot(page, 'm16-close-corridor', CAVE, 75, 34)

    // The shoulder: the mouth at cols 30–31 (arch rows 38–39), the chamber, the far tunnel.
    await setLook(page, { area: 'shoulder', cave: 'lantern' })
    await shot(page, 's01-approach', SURFACE, 30, 42)
    await shot(page, 's02-arch', CAVE, 30, 39)
    await shot(page, 's03-one-in', CAVE, 30, 38)
    await shot(page, 's04-three-in', CAVE, 30, 36)
    await shot(page, 's05-chamber', CAVE, 32, 26)
    await shot(page, 's06-by-crystal', CAVE, 24, 25)
    await shot(page, 's07-far-tunnel', CAVE, 46, 20)
    await setLook(page, { cave: 'dim' })
    await shot(page, 's08-none-chamber', CAVE, 32, 26)
    await setLook(page, { cave: 'lantern' })

    writeFileSync(`${OUT}/states.json`, JSON.stringify(states, null, 1))
    // The light is drawn in the cave, and it's cheap.
    expect(states['m10-cavern']!.cave).toBe(1)
    expect(states['m01-approach']!.layer).toBe(SURFACE)
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  test('height lab: cave light on a phone', async ({ page }) => {
    test.setTimeout(180_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    await setLook(page, { area: 'mountain', cave: 'lantern' })
    const phone: Record<string, LabState> = {}
    for (const [name, layer, tx, ty] of [['p01-one-in', CAVE, 56, 72], ['p02-mid-tunnel', CAVE, 56, 63], ['p03-cavern', CAVE, 42, 44]] as const) {
      await shot(page, name, layer, tx, ty)
      phone[name] = states[name]!
    }
    writeFileSync(`${OUT}/states-phone.json`, JSON.stringify(phone, null, 1))
  })
})
