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
type Hooks = { __fsTerrain: () => Terrain; __fsTerrainSet: (s: Partial<TerrainSettings>) => void; __fsWorldMap: () => MapState; __fsDevParkCreatures: () => number }
const terrain = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsTerrain())
const mapState = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsWorldMap())

async function baked(page: Page): Promise<void> {
  await expect.poll(async () => {
    const s = await terrain(page)
    return s?.on && s.chunks >= 25 && s.pending === 0 && s.images.length >= 9
  }, { timeout: 60_000 }).toBe(true)
  await page.waitForTimeout(900)
}

test.use({ viewport: { width: 1600, height: 1000 } })
test('find generated terrain through every dev button, and read its heights on the world map', async ({ page }) => {
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
      await baked(page)
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
        return Math.hypot(p.x / 16 - chosen.stand[0] - 0.5, p.y / 16 - chosen.stand[1] - 0.5)
      }, { timeout: 60_000 }).toBeLessThan(3)
      await baked(page)
      const state = await terrain(page)
      expect(state.hero.walkable, `${mode}/${kind}: open arrival`).toBe(true)
      frames[`${mode}-${kind}`] = { chosen, arrival: state.hero, label: await page.getByTestId('terrain-destination').textContent() }
      await page.screenshot({ path: `${OUT}/${mode}-${kind}.png` })
      save()
    }
  }

  // At the owner's requested 18% zoom, show the nearest range and its
  // unexplored surroundings. Opening the map must not read SL2 surfaces.
  await warp(page, 'outdoors', ...mapStand)
  await baked(page)
  await page.keyboard.press('Backquote')
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
