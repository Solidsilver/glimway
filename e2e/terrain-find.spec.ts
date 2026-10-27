import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures'
import { freshPlayer } from './home-helpers'
import { player, waitForLive, warp } from './helpers'
import { FEATURE_LABELS, type FeatureKind, type FeatureReply } from '../src/game/terrain/find'
import type { TerrainSettings } from '../src/game/terrain/settings'
import { openingScale } from '../src/lib/wilds/map-view'

const OUT = '.e2e-artifacts/terrain-find'
type Terrain = { on: boolean; chunks: number; pending: number; images: unknown[]; hero: { tile: number[]; z: number; walkable: boolean } }
type MapState = { view: { cx: number; cy: number; scale: number }; vp: { w: number; h: number }; height: { on: boolean; chunks: number; requests: number; version: number; error: string } }
type Hooks = { __fsTerrain: () => Terrain; __fsTerrainSet: (s: Partial<TerrainSettings>) => void; __fsWorldMap: () => MapState; __fsDevParkCreatures: () => number; __fsBanners: () => { current: unknown | null } }
const terrain = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsTerrain())
const mapState = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsWorldMap())

async function baked(page: Page, minImages = 9): Promise<void> {
  let last: Terrain | null = null
  await expect.poll(async () => {
    last = await terrain(page)
    return last?.on && last.chunks >= 25 && last.pending === 0 && last.images.length >= minImages
  }, { timeout: 60_000 }).toBe(true).catch((e: unknown) => {
    writeFileSync(`${OUT}/bake-failure.json`, JSON.stringify(last, null, 2))
    throw e
  })
  await page.waitForTimeout(900)
}

test.use({ viewport: { width: 1600, height: 1000 } })
test('find generated terrain through every dev button, and read its heights on the world map', { tag: '@terrain-proof' }, async ({ page }) => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  await freshPlayer(page)
  await warp(page, 'outdoors', 12, 60)
  await waitForLive(page)
  await page.keyboard.press('Backquote')
  const fold = page.locator('details[data-section="terrain"]')
  if (!(await fold.getAttribute('open') !== null)) await fold.locator('summary').click()
  await expect(page.getByTestId('terrain-go-pass')).toHaveCount(0)
  await page.getByTestId('dev-terrain-on').check()
  await page.evaluate(() => (window as unknown as Hooks).__fsTerrainSet({ sunClock: false, sunTime: 0.3 }))
  const frames: Record<string, unknown> = {}
  let mapStand: [number, number] = [12, 60]
  const save = () => writeFileSync(`${OUT}/evidence.json`, JSON.stringify(frames, null, 2))

  for (const mode of ['top', 'lift'] as const) {
    await fold.getByRole('button', { name: mode === 'top' ? 'Top-down' : 'True ¾ lift', exact: true }).click()
    for (const kind of Object.keys(FEATURE_LABELS) as FeatureKind[]) {
      // The button searches from home each time, making the two looks
      // comparable. Only the destination button performs the feature warp.
      await warp(page, 'outdoors', 12, 60)
      // Fixed Commons chunks keep their authored images, so home has
      // fewer terrain bakes than an all-generated 3×3 arrival window.
      await baked(page, 0)
      const response = page.waitForResponse((r) => r.url().includes('/api/dev/terrain/features?') && r.status() === 200)
      await page.getByTestId(`terrain-go-${kind}`).click()
      const reply = await (await response).json() as FeatureReply
      expect(reply.owners).toBe(9)
      const chosen = reply.features.find((f) => f.kind === kind)!
      expect(chosen, `${kind} exists`).toBeTruthy()
      if (kind === 'pass') mapStand = chosen.stand
      await expect(page.getByTestId('terrain-destination')).toContainText(FEATURE_LABELS[kind], { timeout: 60_000 })
      await expect.poll(async () => {
        const p = await player(page)
        return Math.max(Math.abs(p.x / 16 - chosen.stand[0] - 0.5), Math.abs(p.y / 16 - chosen.stand[1] - 0.5))
      // The existing warp moves off trees/cover within a 24-tile radius.
      // Its terrain-only stand is certified by the Go graph tests.
      }, { timeout: 60_000 }).toBeLessThanOrEqual(24.1)
      await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
      await baked(page)
      await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).__fsBanners().current), { timeout: 15_000 }).toBeNull()
      const state = await terrain(page)
      expect(state.hero.walkable, `${mode}/${kind}: open arrival`).toBe(true)
      const camera = await page.evaluate(() => window.__fsDevCamera?.())
      if (kind === 'spire') {
        const screen = await page.evaluate(({ target, lift }) => {
          const stage = document.querySelector('main > .stage')!.getBoundingClientRect()
          return { w: stage.width, h: stage.height,
            crown: window.__fsDevToScreen!((target[0] + 0.5) * 16, (target[1] + 0.5) * 16 - (lift ? 15 * 48 : 0)),
            base: window.__fsDevToScreen!((target[0] + 0.5) * 16, (target[1] + 24) * 16) }
        }, { target: chosen.target, lift: mode === 'lift' })
        for (const p of [screen.crown, screen.base]) {
          expect(p.x, 'spire inside viewport').toBeGreaterThan(0)
          expect(p.x, 'spire inside viewport').toBeLessThan(screen.w)
          expect(p.y, 'spire inside viewport').toBeGreaterThan(0)
          expect(p.y, 'spire inside viewport').toBeLessThan(screen.h)
        }
        frames[`${mode}-spire-screen`] = screen
      }
      frames[`${mode}-${kind}`] = { chosen, arrival: state.hero, camera, label: await page.getByTestId('terrain-destination').textContent() }
      await page.screenshot({ path: `${OUT}/${mode}-${kind}.png` })
      save()
    }
  }

  // At the owner's requested 18% zoom, show the nearest range and its
  // unexplored surroundings. Opening the map must not read SL2 surfaces.
  await warp(page, 'outdoors', ...mapStand)
  await baked(page)
  await page.keyboard.press('Backquote')
  await baked(page)
  const surfaceReads: string[] = []
  const reads: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname === '/api/dev/terrain') surfaceReads.push(r.url())
    if (url.pathname === '/api/dev/terrain/map') reads.push(r.url())
  })
  await page.keyboard.press('m')
  await expect(page.getByTestId('map-height-layer')).toBeChecked()
  await expect.poll(async () => (await mapState(page))?.height.chunks, { timeout: 30_000 }).toBeGreaterThan(0)
  // Use the real zoom buttons until the readout is 18%.
  while (true) {
    const s = await mapState(page)
    const pct = Math.round(s.view.scale / openingScale(s.vp, 24) * 100)
    if (pct <= 18) break
    await page.getByTestId('map-zoom-out').click()
  }
  await expect.poll(async () => (await mapState(page)).height.error).toBe('')
  await page.waitForTimeout(2500)
  frames['map-18'] = await mapState(page)
  await page.screenshot({ path: `${OUT}/map-18.png` })
  for (let i = 0; i < 6; i++) await page.getByTestId('map-zoom-in').click()
  await page.waitForTimeout(2000)
  frames['map-close'] = await mapState(page)
  await page.screenshot({ path: `${OUT}/map-close.png` })
  const before = reads.length
  await page.getByTestId('map-height-layer').uncheck()
  await expect(page.getByTestId('map-height-canvas')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(reads.length).toBe(before)
  await page.screenshot({ path: `${OUT}/map-off.png` })
  expect(surfaceReads, 'map opening/pan/zoom never asks for SL2 terrain').toEqual([])
  frames.mapReads = reads.map((u) => new URL(u).searchParams.getAll('c').length)
  expect((frames.mapReads as number[]).every((n) => n <= 256)).toBe(true)
  save()
})
