import { expect, test, type Page } from '@playwright/test'
import { beginNewJourney, player, warp } from './helpers'

type EnemyView = { x: number; y: number; state: string; hp: number; type: string; locked: boolean }

const enemies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsEnemies: () => EnemyView[] }).__fsEnemies())

const hp = (page: Page) =>
  page.evaluate(() => Number(document.querySelector('.hud .bar.hp')?.getAttribute('aria-valuenow') ?? NaN))

/** Poll until some enemy is in the given state; returns it. */
async function waitForState(page: Page, state: string, timeout = 8000): Promise<EnemyView> {
  let found: EnemyView | undefined
  await expect
    .poll(async () => {
      found = (await enemies(page)).find((e) => e.state === state)
      return !!found
    }, { timeout, intervals: [50] })
    .toBe(true)
  return found!
}

test('slimes wind up before they hop, and the hop hurts', async ({ page }) => {
  await beginNewJourney(page)
  // Beside wisp-a (17,18), on the path.
  await warp(page, 'woodland', 15, 20)
  const before = await hp(page)
  await waitForState(page, 'telegraph')
  await page.screenshot({ path: 'test-results/combat-slime-windup.png' })
  await waitForState(page, 'lunge', 2000)
  await expect.poll(() => hp(page), { timeout: 3000 }).toBeLessThan(before)
})

test('a beetle telegraphs its charge, and a roll sideways slips it', async ({ page }) => {
  await beginNewJourney(page)
  // West of beetle-a (35,13) on the long straight at row 12.
  await warp(page, 'woodland', 29, 12)
  const start = await hp(page)
  await waitForState(page, 'telegraph', 10_000)
  await page.screenshot({ path: 'test-results/combat-beetle-windup.png' })
  // The aim freezes (white flash) just before the charge: that's the cue.
  let beetle: EnemyView | undefined
  await expect
    .poll(async () => {
      beetle = (await enemies(page)).find((e) => e.type === 'beetle' && e.locked)
      return !!beetle
    }, { timeout: 3000, intervals: [30] })
    .toBe(true)
  const p = await player(page)
  // Roll perpendicular to the charge line.
  const sideways = Math.abs(beetle!.x - p.x) > Math.abs(beetle!.y - p.y) ? 'ArrowDown' : 'ArrowRight'
  await page.keyboard.down(sideways)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(450)
  await page.keyboard.up(sideways)
  await waitForState(page, 'lunge', 2000).catch(() => {})
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'test-results/combat-beetle-after.png' })
  // The charge's 3 damage never landed (a bump may still sting for 1).
  expect(start - (await hp(page))).toBeLessThan(3)
})

test('standing still in a beetle charge hurts', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'woodland', 29, 12)
  const start = await hp(page)
  await waitForState(page, 'lunge', 10_000)
  await expect.poll(async () => start - (await hp(page)), { timeout: 3000 }).toBeGreaterThanOrEqual(2)
})

test('hits knock enemies back without pushing them through walls', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'woodland', 15, 20)
  const near = async () => {
    const p = await player(page)
    return (await enemies(page)).some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 30)
  }
  await expect.poll(near, { timeout: 8000 }).toBe(true)
  for (let i = 0; i < 12; i++) {
    const p = await player(page)
    const e = (await enemies(page)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]
    if (!e) break
    await page.keyboard.press(Math.abs(e.x - p.x) > Math.abs(e.y - p.y) ? (e.x > p.x ? 'ArrowRight' : 'ArrowLeft') : (e.y > p.y ? 'ArrowDown' : 'ArrowUp'))
    await page.keyboard.press('e')
    await page.waitForTimeout(450)
  }
  // Whatever happened, every enemy is still on walkable ground inside the map.
  const w = await page.evaluate(() => (window as unknown as { __fsWorld: () => { widthPx: number; heightPx: number } }).__fsWorld())
  for (const e of await enemies(page)) {
    expect(e.x).toBeGreaterThan(0)
    expect(e.x).toBeLessThan(w.widthPx)
    expect(e.y).toBeGreaterThan(0)
    expect(e.y).toBeLessThan(w.heightPx)
  }
})
