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

type Look = { area?: 'shoulder' | 'mountain'; cave?: 'lantern' | 'wide' | 'dim'; skyTiles?: number; caveStyle?: 'mixed' | 'built' | 'rough'; darkness?: number; way?: 'blend' | 'eased' | 'stages' | 'iris'; crossfade?: number }
type LabState = {
  area: string
  look: Look
  built: Look
  layer: number
  z: number
  sky: number
  walked?: number
  cave: number
  alpha?: number
  light: number
  lightMs: number
  corners?: { shown: number[]; own: number[] }
  uncapped?: number
  iris?: number
}
type Lab = { put: (layer: number, tx: number, ty: number) => void; look: (l: Look) => void; state: () => LabState }

const labState = (page: Page) => page.evaluate(() => (window as unknown as { __fsLab: Lab }).__fsLab.state())

async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate((l) => (window as unknown as { __fsLab: Lab }).__fsLab.look(l), look)
  // Some switches rebuild the scene: wait until a scene built with them is up.
  for (const [k, v] of Object.entries(look) as [keyof Look, unknown][])
    await expect
      .poll(() => page.evaluate((key) => {
        const lab = (window as unknown as { __fsLab?: Lab }).__fsLab
        if (!lab) return undefined
        const st = lab.state()
        return key === 'area' || key === 'skyTiles' || key === 'caveStyle' ? st.built[key] : st.look[key]
      }, k), { timeout: 30_000 })
      .toBe(v)
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

  test('height lab round 4: walking the ramps, the ghost spots, the ledge, the styles', async ({ page }) => {
    test.setTimeout(420_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    // The shoulder: the owner's three ghost spots, then each ramp walked down and up again, with
    // steps inside a tile near where round 3 cut its level images.
    await setLook(page, { area: 'shoulder', cave: 'lantern', skyTiles: 6, caveStyle: 'mixed', darkness: 0.6 })
    await shot(page, 'r4-s-ghost1-east-ramp-top', CAVE, 51, 20)
    await shot(page, 'r4-s-ghost2-east-ramp-mid', CAVE, 46, 20)
    await shot(page, 'r4-s-ghost3-north-ramp-entry', CAVE, 30, 38)
    for (const [n, ty] of [[1, 38.5], [2, 37.5], [3, 36.8], [4, 35], [5, 33.2], [6, 32]] as const) await shot(page, `r4-s-north-down-${n}`, CAVE, 30.5, ty)
    for (const [n, ty] of [[1, 32.5], [2, 34.6], [3, 37.1], [4, 38]] as const) await shot(page, `r4-s-north-up-${n}`, CAVE, 30.5, ty)
    for (const [n, tx] of [[1, 52], [2, 50.6], [3, 50.2], [4, 47.5], [5, 45.6], [6, 45.2], [7, 42.5], [8, 40]] as const) await shot(page, `r4-s-east-down-${n}`, CAVE, tx, 20.5)
    for (const [n, tx] of [[1, 41], [2, 45.4], [3, 50.4], [4, 52.5]] as const) await shot(page, `r4-s-east-up-${n}`, CAVE, tx, 20.5)
    await shot(page, 'r4-s-chamber-rough', CAVE, 32, 26)

    // The mountain: the first descent (ramp A, cut stairs), the bend's rough ramp B, the long
    // exit (ramp E, four levels), the ledge over the cavern.
    await setLook(page, { area: 'mountain' })
    for (const [n, ty] of [[1, 68], [2, 66.6], [3, 66.2], [4, 64.5], [5, 62.8], [6, 61.5], [7, 59]] as const) await shot(page, `r4-m-a-down-${n}`, CAVE, 56.5, ty)
    for (const [n, ty] of [[1, 60.5], [2, 63.4], [3, 66.4], [4, 67.5]] as const) await shot(page, `r4-m-a-up-${n}`, CAVE, 56.5, ty)
    for (const [n, tx] of [[1, 68], [2, 70.5], [3, 72.4], [4, 75.5]] as const) await shot(page, `r4-m-b-${n}`, CAVE, tx, 58.5)
    for (const [n, ty] of [[1, 50], [2, 52.5], [3, 54.7], [4, 56.3], [5, 58.2], [6, 60.6], [7, 62.4], [8, 64.6], [9, 66]] as const) await shot(page, `r4-m-e-up-${n}`, CAVE, 40.5, ty)
    for (const [n, ty] of [[1, 65.5], [2, 61.5], [3, 57.5], [4, 53.5]] as const) await shot(page, `r4-m-e-down-${n}`, CAVE, 40.5, ty)
    await shot(page, 'r4-m-ledge', CAVE, 44, 31)
    await shot(page, 'r4-m-ledge-west', CAVE, 30, 30)
    await shot(page, 'r4-m-ramp-d-mid', CAVE, 26.5, 37)
    await setLook(page, { darkness: 0 })
    await shot(page, 'r4-m-ledge-dark0', CAVE, 44, 31)
    await setLook(page, { darkness: 0.9 })
    await shot(page, 'r4-m-ledge-dark90', CAVE, 44, 31)
    await setLook(page, { darkness: 0.6 })
    // The styles, switched: all cut, all rough.
    await setLook(page, { caveStyle: 'built' })
    await shot(page, 'r4-m-built-ramp-b', CAVE, 71, 58.5)
    await shot(page, 'r4-m-built-ramp-e', CAVE, 40.5, 58)
    await setLook(page, { caveStyle: 'rough' })
    await shot(page, 'r4-m-rough-ramp-a', CAVE, 56.5, 64)
    await shot(page, 'r4-m-rough-cavern', CAVE, 42, 44)
    await setLook(page, { caveStyle: 'mixed' })
    writeFileSync(`${OUT}/states-r4.json`, JSON.stringify(Object.fromEntries(Object.entries(states).filter(([k]) => k.startsWith('r4-'))), null, 1))
    // Smooth: within a ramp the level changes in fractions.
    expect(Math.abs(states['r4-m-e-up-4']!.z % 1)).toBeGreaterThan(0.01)
  })

  test('height lab round 4: the mouths from outside, in, at daylight 3 and 10, lantern and none', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    const mouths = [
      { area: 'mountain', name: 'm-east', x: 56, arch: 73 },
      { area: 'mountain', name: 'm-west', x: 40, arch: 73 },
      { area: 'shoulder', name: 's-first', x: 30, arch: 39 },
      { area: 'shoulder', name: 's-second', x: 52, arch: 24 }
    ] as const
    const mouthStates: Record<string, LabState> = {}
    for (const sky of [3, 10])
      for (const light of ['lantern', 'dim'] as const)
        for (const m of mouths) {
          await setLook(page, { area: m.area, skyTiles: sky, cave: light, caveStyle: 'mixed', darkness: 0.6 })
          for (const [pos, layer, ty] of [['out2', SURFACE, m.arch + 3], ['out1', SURFACE, m.arch + 1], ['portal', CAVE, m.arch], ['in1', CAVE, m.arch - 1], ['in2', CAVE, m.arch - 2], ['in3', CAVE, m.arch - 3]] as const) {
            const name = `r4-mouth-${m.name}-sky${sky}-${light}-${pos}`
            await shot(page, name, layer, m.x + 0.5, ty)
            mouthStates[name] = states[name]!
          }
        }
    writeFileSync(`${OUT}/states-r4-mouths.json`, JSON.stringify(mouthStates, null, 1))
  })

  test('height lab round 4b: the way in, each way, in half-tile steps at three mouths', async ({ page }) => {
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    const mouths = [
      { area: 'mountain', name: 'm-east', x: 56, arch: 73 },
      { area: 'mountain', name: 'm-west', x: 40, arch: 73 },
      { area: 'shoulder', name: 's-second', x: 52, arch: 24 }
    ] as const
    const ways: Record<string, LabState> = {}
    for (const m of mouths)
      for (const way of ['blend', 'eased', 'stages', 'iris'] as const) {
        await setLook(page, { area: m.area, way, crossfade: 3, skyTiles: 6, cave: 'lantern', caveStyle: 'mixed', darkness: 0.6 })
        // From two tiles out to three in: a foot a tile past the arch's foot row is outside.
        for (let k = 0; k <= 10; k++) {
          const ty = m.arch + 2 - k * 0.5
          const layer = Math.floor(ty + 10 / 16) > m.arch ? SURFACE : CAVE
          const name = `w-${way}-${m.name}-${String(k).padStart(2, '0')}`
          await shot(page, name, layer, m.x + 0.5, ty)
          ways[name] = states[name]!
        }
      }
    writeFileSync(`${OUT}/states-way.json`, JSON.stringify(ways, null, 1))
    // The cave's floors never show brighter mid-way than once in: the cap held (what it stopped is in `uncapped`).
    expect(Object.values(ways).every((st) => st.layer === SURFACE || st.cave > 0 || st.alpha === 0)).toBe(true)
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

  test('height lab round 4b: the way in on a phone, each way, the mountain\'s east mouth', async ({ page }) => {
    test.setTimeout(600_000)
    mkdirSync(OUT, { recursive: true })
    await openLab(page)
    const phone: Record<string, LabState> = {}
    for (const way of ['blend', 'eased', 'stages', 'iris'] as const) {
      await setLook(page, { area: 'mountain', way, crossfade: 3, skyTiles: 6, cave: 'lantern', caveStyle: 'mixed', darkness: 0.6 })
      for (let k = 0; k <= 10; k++) {
        const ty = 73 + 2 - k * 0.5
        const layer = Math.floor(ty + 10 / 16) > 73 ? SURFACE : CAVE
        const name = `pw-${way}-m-east-${String(k).padStart(2, '0')}`
        await shot(page, name, layer, 56.5, ty)
        phone[name] = states[name]!
      }
    }
    writeFileSync(`${OUT}/states-way-phone.json`, JSON.stringify(phone, null, 1))
  })
})
