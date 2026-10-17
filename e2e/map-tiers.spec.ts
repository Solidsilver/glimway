import { expect, test } from './fixtures'
import { accountOf, reenter, sql, wickSlack } from './connected'
import { claimDeed, freshPlayer, fund, homes, readOn, talk } from './home-helpers'
import { waitForLive, warp } from './helpers'
import { lanternStake, lotOrigin } from '../src/lib/lots.ts'

// A real lot lantern, read through the map's protocol. The server's unit
// tests cover explored-only camps/Common and all boundary predictions.
for (const phone of [false,true]) {
  test(`Lamps ledger shows your dimming lot and centres its mark (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
    test.setTimeout(180_000)
    if (phone) await page.setViewportSize({ width: 360, height: 800 })
    const id = await freshPlayer(page)
    await wickSlack(page)
    const gate = await claimDeed(page)
    fund(id,{ items: { 'hearth-oil': 1 } })
    await reenter(page)
    await page.evaluate(() => (window as unknown as { __fsHomes: { fresh(): Promise<void> } }).__fsHomes.fresh())
    const o = lotOrigin(gate), stake = lanternStake(gate,12)
    await warp(page,'outdoors',o.tx+stake.x,o.ty+stake.y+1)
    await talk(page,/Look at the lantern/,/Fill it with hearth oil/)
    await readOn(page,/The lantern burns/)
    await expect.poll(async () => (await homes(page)).mine?.lantern?.lit).toBe(true)
    sql(`UPDATE lot_lanterns SET oil=0,dimming=1 WHERE homestead_id IN (SELECT homestead_id FROM homestead_members WHERE account_id='${accountOf(id)}');`)
    await waitForLive(page)
    const mutations: string[] = []
    page.on('request', (r) => { if (r.method()==='POST' && /\/api\/(camps|homestead\/lantern|wilds\/(lay|clear|lift))$/.test(new URL(r.url()).pathname)) mutations.push(r.url()) })
    await page.keyboard.press('m')
    await expect(page.getByTestId('world-map')).toBeVisible()
    await page.getByTestId('map-details-toggle').click()
    const row = page.locator(`[data-lamp="lot-lantern:${gate}"]`)
    await expect(row).toContainText('Lot lantern')
    await expect(row).toContainText('Built · dimming')
    await expect(row).toContainText('0 wicks in reserve')
    await expect(row).toContainText('Turns next turning unless tended')
    await row.click()
    await expect(page.getByTestId('map-status')).toHaveText('Lot lantern')
    const mark = await page.evaluate(() => (window as unknown as { __fsWorldMap(): { view: { cx: number;cy: number };vp: { w: number;h: number } } }).__fsWorldMap())
    // The lot stake is within the displayed map; selecting the row uses its
    // world coordinates and the normal clamp (which can centre a narrow frame).
    expect(mark.view.cx).toBeCloseTo(o.tx+stake.x+0.5,0)
    const details = await page.getByTestId('map-details').boundingBox()
    expect(details!.x).toBeGreaterThanOrEqual(0)
    expect(details!.x+details!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.getByTestId('map-lamps-layer').uncheck()
    await expect(page.getByTestId('map-lamps-layer')).not.toBeChecked()
    expect(mutations).toEqual([])
  })
}
