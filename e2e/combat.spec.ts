import { expect, test, type Page } from './fixtures'
import { beginNewJourney, expectStage, player, savedStage, stepToWarden, strikeAll, talkThrough, warden, warp } from './helpers'

type EnemyView = { x: number; y: number; state: string; hp: number; type: string; locked: boolean; body: { x: number; y: number; w: number; h: number } }

const enemies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsEnemies: () => EnemyView[] }).__fsEnemies())

const hp = (page: Page) =>
  page.evaluate(() => Number(document.querySelector('.hud .bar.hp')?.getAttribute('aria-valuenow') ?? NaN))

/** Poll until an enemy (optionally of one type) matches; returns it. */
async function waitForEnemy(page: Page, match: (e: EnemyView) => boolean, timeout = 8000): Promise<EnemyView> {
  let found: EnemyView | undefined
  await expect
    .poll(async () => {
      found = (await enemies(page)).find(match)
      return !!found
    }, { timeout, intervals: [30] })
    .toBe(true)
  return found!
}

/** Alone with beetle-a on the long straight at row 12: the slimes are cleared
 *  first, so any damage taken is the beetle's. */
async function faceBeetle(page: Page): Promise<void> {
  await beginNewJourney(page)
  await warp(page, 'woodland', 29, 12)
  await strikeAll(page, 999, 'wisp')
  await expect.poll(async () => (await enemies(page)).every((e) => e.type === 'beetle')).toBe(true)
}

test('slimes wind up before they hop, and the hop hurts', async ({ page }) => {
  await beginNewJourney(page)
  // Beside wisp-a (17,18), on the path.
  await warp(page, 'woodland', 15, 20)
  const before = await hp(page)
  await waitForEnemy(page, (e) => e.type === 'wisp' && e.state === 'telegraph')
  await page.screenshot({ path: 'test-results/combat-slime-windup.png' })
  await waitForEnemy(page, (e) => e.type === 'wisp' && e.state === 'lunge', 2000)
  await expect.poll(() => hp(page), { timeout: 3000 }).toBeLessThan(before)
})

test('standing still in a beetle charge hurts', async ({ page }) => {
  await faceBeetle(page)
  const start = await hp(page)
  await waitForEnemy(page, (e) => e.type === 'beetle' && e.state === 'lunge', 10_000)
  // The charge (3, less mitigation) lands — more than a bump's sting.
  await expect.poll(async () => start - (await hp(page)), { timeout: 3000 }).toBeGreaterThanOrEqual(2)
})

test('a beetle telegraphs its charge, and a roll sideways slips it', async ({ page }) => {
  await faceBeetle(page)
  const start = await hp(page)
  await waitForEnemy(page, (e) => e.type === 'beetle' && e.state === 'telegraph', 10_000)
  await page.screenshot({ path: 'test-results/combat-beetle-windup.png' })
  // Roll sideways on the frame the aim locks (the white flash). Done inside
  // the page so a busy machine can't make the test react late.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    type W = {
      __fsEnemies: () => { x: number; y: number; type: string; locked: boolean }[]
      __fsPlayer: () => { x: number; y: number }
      __fsWorld: () => { solid: boolean[][] }
      __fsDevDodge: (dx: number, dy: number) => void
    }
    const w = window as unknown as W
    const until = performance.now() + 3000
    const tick = () => {
      const b = w.__fsEnemies().find((e) => e.type === 'beetle' && e.locked)
      if (!b) {
        if (performance.now() > until) reject(new Error('beetle never locked its aim'))
        else requestAnimationFrame(tick)
        return
      }
      const p = w.__fsPlayer()
      const solid = w.__fsWorld().solid
      const open = (dx: number, dy: number) =>
        [1, 2, 3].every((k) => !solid[Math.floor((p.y - 2) / 16) + dy * k]?.[Math.floor(p.x / 16) + dx * k])
      const horizontal = Math.abs(b.x - p.x) > Math.abs(b.y - p.y)
      if (horizontal) w.__fsDevDodge(0, open(0, 1) ? 1 : -1)
      else w.__fsDevDodge(open(1, 0) ? 1 : -1, 0)
      resolve()
    }
    tick()
  }))
  // The charge really launched, and finished without connecting.
  await waitForEnemy(page, (e) => e.type === 'beetle' && e.state !== 'telegraph' && e.state !== 'chase', 2000)
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'test-results/combat-beetle-after.png' })
  expect(start - (await hp(page))).toBeLessThan(2)
})

test('Shift rolls the hero and starts the roll cooldown', async ({ page }) => {
  await beginNewJourney(page)
  const before = await player(page)
  await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Shift')
  await page.waitForTimeout(150)
  await page.keyboard.up('ArrowRight')
  await expect(page.locator('.actionbar .slot.roll .sweep')).toBeVisible()
  expect((await player(page)).x).toBeGreaterThan(before.x + 10)
})

test('knockback never leaves an enemy on a wall, tree or water tile', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'woodland', 15, 20)
  const near = async () => {
    const p = await player(page)
    return (await enemies(page)).some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 60)
  }
  await expect.poll(near, { timeout: 15_000 }).toBe(true)
  const w = await page.evaluate(() => (window as unknown as { __fsWorld: () => { widthPx: number; heightPx: number; solid: boolean[][] } }).__fsWorld())
  let hits = 0
  for (let i = 0; i < 12; i++) {
    const p = await player(page)
    const e = (await enemies(page)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]
    if (!e) break
    await page.keyboard.press(Math.abs(e.x - p.x) > Math.abs(e.y - p.y) ? (e.x > p.x ? 'ArrowRight' : 'ArrowLeft') : (e.y > p.y ? 'ArrowDown' : 'ArrowUp'))
    await page.keyboard.press('e')
    await page.waitForTimeout(250)
    // Mid-shove and after: the collision box's center is never inside a
    // solid tile (the drawn feet may overhang a tree's edge by a pixel).
    for (const en of await enemies(page)) {
      const tx = Math.floor((en.body.x + en.body.w / 2) / 16)
      const ty = Math.floor((en.body.y + en.body.h / 2) / 16)
      expect(en.x).toBeGreaterThan(0)
      expect(en.x).toBeLessThan(w.widthPx)
      expect(w.solid[ty]?.[tx], `enemy at tile ${tx},${ty} is inside a solid`).toBe(false)
      hits++
    }
    await page.waitForTimeout(200)
  }
  expect(hits).toBeGreaterThan(0)
})

test('the warden: blows never settle it, holding up the rubbing does', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /rubbing of the marker/)
  await expect.poll(async () => (await warden(page)).state).toBe('active')

  // Blows ring off the stone: any number, any size, and a real swing.
  for (let i = 0; i < 3; i++) await strikeAll(page, 999, 'guardian')
  await stepToWarden(page, 20, false)
  // Let a frame pass so nothing near the old spot still claims the press.
  await expect(page.locator('.prompt')).toBeHidden()
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: 'rings off the stone' })).toBeVisible()
  let g = await warden(page)
  expect(g.state).toBe('active')
  expect(g.showings).toBe(0)
  expect(await savedStage(page)).toBe('clue-found')

  // Bait a lunge from a few steps off; when it stops to find its feet,
  // step in and hold up the rubbing. Each showing makes it falter.
  for (let i = 1; i <= g.needed; i++) {
    await stepToWarden(page, 84, false)
    await stepToWarden(page, 20, true)
    await expect(page.locator('.prompt')).toContainText('Hold up the rubbing')
    if (i === 1) await page.screenshot({ path: 'test-results/warden-showing.png' })
    await page.keyboard.press('e')
    await expect.poll(async () => (await warden(page)).showings).toBe(i)
  }

  // Settled: resting in its pose, still there, and the quest moves on.
  await expectStage(page, 'guardian-defeated')
  g = await warden(page)
  expect(g.state).toBe('settled')
  expect(g.visible).toBe(true)
  await page.waitForTimeout(800)
  expect((await warden(page)).texture).toBe('guardian-defeat')
  expect(await enemies(page)).toHaveLength(0)

  // Come back later: it is on its post, at rest.
  await warp(page, 'village', 16, 14)
  await warp(page, 'ruin', 3, 13)
  g = await warden(page)
  expect(g.state).toBe('settled')
  expect(g.visible).toBe(true)
  expect(g.texture).toBe('guardian-defeat')
})
