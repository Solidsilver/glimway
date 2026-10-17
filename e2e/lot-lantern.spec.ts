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

test('fill the lot lantern, set a stool out in the backland, see the lantern lit', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page, 'Wick')
  fund(id, { items: { 'hearth-oil': 1 } })
  seedGlims(id, 20)
  const gate = await claimDeed(page)

  // A stool from Silas's yard.
  await silasSays(page, /See the Yard/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.getByRole('tab', { name: 'Furnish' }).click()
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden Stool is yours')
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
  await goLot(page, gate, gate % 2 ? 21 : 2, stake.y)
  await page.getByTestId('arrange').click()
  const tray = page.getByTestId('placement-tray')
  await tray.locator('[data-piece="wooden-stool"]').first().click()
  await expect.poll(async () => (await homes(page)).placement?.spot ?? null).not.toBeNull()
  const out = gate % 2 ? 'ArrowRight' : 'ArrowLeft'
  const placement = async () => (await homes(page)).placement!
  const deep = (x: number) => (gate % 2 ? x - 23 : -x) >= 2
  for (let step = 0; step < 40; step++) {
    const p = await placement()
    if (inBackland(p.spot!.x, p.spot!.y, gate) && deep(p.spot!.x) && p.problem === null) break
    const before = JSON.stringify(p.spot)
    // Out past the line first; then down the backland until the ground is open.
    await page.keyboard.press(!deep(p.spot!.x) ? out : step % 6 === 5 ? out : 'ArrowDown')
    await expect.poll(async () => JSON.stringify((await placement()).spot)).not.toBe(before)
  }
  const spot = (await placement()).spot!
  expect(inBackland(spot.x, spot.y, gate)).toBe(true)
  expect((await placement()).problem).toBeNull()
  await page.keyboard.press('e')
  await expect(tray.locator('.status')).toContainText('set out')
  await tray.getByRole('button', { name: /Done/ }).click()
  await expect.poll(async () => (await homeAt(page, gate))?.items.find((i) => i.itemDef === 'wooden-stool')).toMatchObject({ scene: 'outdoor', x: spot.x, y: spot.y })
  await shot(page, 'lot-lantern-backland-stool')
})
