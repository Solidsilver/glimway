import { expect, test, type Page } from './fixtures'
import { claimDeed, freshPlayer, fund, goLot, homeAt, homes, readOn, seedGlims, shot, silasSays, talk, throughGate } from './home-helpers'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import { inBackland, lanternStake, lotOrigin } from '../src/lib/lots.ts'

/**
 * Lot lanterns (roadmap 0.12), against the real Go server: a member fills
 * the dark lantern on their lot's back line with hearth oil, it lights (the
 * stake is drawn lit) and holds the woods behind the lot, and the yard
 * grows into them: a stool carried past the back line sets down in the
 * backland. The turnings (burn, dim, lapse) are the server's tests.
 */

/** The stake images drawn within a tile of world px (x, y). */
const stakesAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => (window as unknown as { __fsImagesNamed: (p: string) => { key: string; x: number; y: number }[] }).__fsImagesNamed('hw2:lantern-stake-')
    .filter((i) => Math.abs(i.x - px) < 16 && Math.abs(i.y - py) < 24).map((i) => i.key), [x, y] as const)

/**
 * The open backland tile (two or more columns past the back line) nearest
 * `from` for the 1×1 piece being placed, found by tapping each in turn as a
 * pointer would; the piece goes back to `from` after. Else how many tiles
 * had each problem ('stuck': the tap didn't move the piece).
 */
const openBackland = (page: Page, gate: number, from: { x: number; y: number }) =>
  page.evaluate(([gate, fx, fy]) => {
    const w = window as unknown as { __fsDevTapTile: (x: number, y: number) => void; __fsHomes: () => { placement: { problem: string | null; spot: { x: number; y: number } | null } | null } }
    const tiles: { x: number; y: number }[] = []
    for (let y = 0; y < 24; y++) for (let i = 2; i < 24; i++) tiles.push({ x: gate % 2 ? 23 + i : -i, y })
    tiles.sort((a, b) => Math.abs(a.x - fx) + Math.abs(a.y - fy) - (Math.abs(b.x - fx) + Math.abs(b.y - fy)))
    const problems: Record<string, number> = {}
    let found: { x: number; y: number } | null = null
    for (const t of tiles) {
      w.__fsDevTapTile(t.x, t.y)
      const p = w.__fsHomes().placement
      const why = p?.spot?.x !== t.x || p.spot.y !== t.y ? 'stuck' : p.problem
      if (why === null) {
        found = t
        break
      }
      problems[why] = (problems[why] ?? 0) + 1
    }
    w.__fsDevTapTile(fx, fy)
    return found ?? { problems }
  }, [gate, from.x, from.y] as const)

test('fill the lot lantern, set a stool out in the backland, see the lantern lit', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page, 'Wick')
  fund(id, { items: { 'hearth-oil': 1 } })
  // The pack was read when the world opened: read it again, or the oil is
  // only known if that read happened to land after the fund.
  await page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
  seedGlims(id, 20)
  const gate = await claimDeed(page)

  // A stool from Silas's yard.
  await silasSays(page, /See the Yard/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.getByRole('tab', { name: 'Furnish' }).click()
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden stool is yours')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // The lantern on the back line: dark, then filled.
  await throughGate(page, gate)
  const o = lotOrigin(gate)
  const stake = lanternStake(gate, HOMESTEAD_DATA.lotLantern.stakeY)
  const stakePx = { x: (o.tx + stake.x) * 16 + 8, y: (o.ty + stake.y) * 16 + 8 }
  expect((await homeAt(page, gate))?.lantern?.lit).toBe(false)
  await goLot(page, gate, stake.x, stake.y + 1)
  await expect.poll(() => stakesAt(page, stakePx.x, stakePx.y)).toEqual(['hw2:lantern-stake-0'])
  await talk(page, /Look at the lantern/, /Fill it with hearth oil/)
  // The lantern answers with its readout once the oil is in.
  await readOn(page, /The lantern burns, 1 of 3 wicks/)
  await expect.poll(async () => (await homeAt(page, gate))?.lantern).toEqual({ lit: true, oil: 1, dimming: false })
  await expect.poll(() => stakesAt(page, stakePx.x, stakePx.y)).toEqual(['hw2:lantern-stake-1'])
  await shot(page, 'lot-lantern-lit')

  // Arrange from inside the fence: carry the stool out past the back line.
  // The grid only reaches into the backland once this screen has the lantern lit.
  await goLot(page, gate, gate % 2 ? 21 : 2, stake.y)
  await expect.poll(async () => (await homes(page)).here?.lantern?.lit ?? null).toBe(true)
  await page.getByTestId('arrange').click()
  const tray = page.getByTestId('placement-tray')
  await tray.locator('[data-piece="wooden-stool"]').first().click()
  await expect.poll(async () => (await homes(page)).placement?.spot ?? null).not.toBeNull()
  const placement = async () => (await homes(page)).placement!
  const start = (await placement()).spot!
  // The backland is Wilds ground from the world's own (random) seed: where
  // it's open differs every run. Find the open tile at least two columns
  // out nearest the stool by trying each (a tap moves the piece; the tray
  // judges the spot at once), then put the stool back where it started.
  let target = start
  // Polled: the backland's chunk may still be loading. A miss says what each tile's problem was.
  await expect.poll(async () => {
    const r = await openBackland(page, gate, start)
    if ('x' in r) target = r
    return r
  }, { timeout: 15_000 }).toHaveProperty('x')
  expect((await placement()).spot).toMatchObject({ x: start.x, y: start.y })
  // Then carry it there on the keys: out past the line, then along it.
  const press = async (key: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const before = JSON.stringify((await placement()).spot)
      await page.keyboard.press(key)
      await expect.poll(async () => JSON.stringify((await placement()).spot)).not.toBe(before)
    }
  }
  await press(target.x < start.x ? 'ArrowLeft' : 'ArrowRight', Math.abs(target.x - start.x))
  await press(target.y < start.y ? 'ArrowUp' : 'ArrowDown', Math.abs(target.y - start.y))
  const spot = (await placement()).spot!
  expect(spot).toMatchObject(target)
  expect(inBackland(spot.x, spot.y, gate)).toBe(true)
  expect((await placement()).problem).toBeNull()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await tray.getByRole('button', { name: /Done/ }).click()
  await expect.poll(async () => (await homeAt(page, gate))?.items.find((i) => i.itemDef === 'wooden-stool')).toMatchObject({ scene: 'outdoor', x: spot.x, y: spot.y })
  await shot(page, 'lot-lantern-backland-stool')
})
