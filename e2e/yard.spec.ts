import { expect, test, type Page } from './fixtures'
import { accountOf, CONTRACT } from './connected'
import { claimDeed, earnGlims, freshPlayer, fund, giveInstance, go, homes, lane, myHome, shot, talk } from './home-helpers'
import { expectToast } from './helpers'
import { SILAS_YARD } from '../src/content/expansion-writing.ts'
import { DEED_PANEL_COPY, PELL_DEED } from '../src/content/pell.ts'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'

/**
 * Silas's Yard (silas-yard.md 2.5, 2.6), against the real Go server: the
 * Yard panel's four tabs (a buy on Furnish and on Materials, Mend refused
 * while Silas is out of reach, then done beside him), and Pell's Manage your
 * deed panel (sharing with someone at the deed table, then giving up a
 * place). The panels open through their entry points (src/game/yard-open.ts
 * emits these events); the walk into the shop is lane Y-B's.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */

const openYard = (page: Page, tab?: string) => page.evaluate((t) => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('ui:home-shop', t ? { tab: t } : {}), tab)
const openDeed = (page: Page) => page.evaluate(() => (window as unknown as { __fsEmit: (e: string) => void }).__fsEmit('ui:home-deed'))
const reloadItems = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())

/** Silas's spot (the menders row today; his cycle's counter in 0.7). */
async function bySilas(page: Page): Promise<void> {
  const silas = (await homes(page)).features?.silas ?? { tx: 51, ty: 21 }
  await go(page, 'commons', silas.tx, silas.ty + 1)
}

test('the Yard panel: Build first while the cottage is to raise, a buy on Furnish and Materials, Mend only beside Silas', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Tansy')
  await earnGlims(page, id)
  await claimDeed(page)
  const brack = giveInstance(id, 'brack-felling-axe', { uses: 0, max: 240 })
  fund(id, { materials: { timber: 4 }, items: { 'wooden-peg': 1 } })
  await reloadItems(page)
  await bySilas(page)

  // No tab asked: a camp can raise a cottage, so it opens on Build.
  await openYard(page)
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(yard.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true')
  await expect(yard.getByTestId('yard-counter')).toContainText(SILAS_YARD.tabQuotes.build.camp)
  await expect(yard.getByTestId('yard-upgrade')).toContainText(HOMESTEAD_DATA.tiers[1].name)
  await expect(yard.getByTestId('shop-buildings').locator('[data-buy="lantern-post"]')).toHaveCount(1)
  await expect(yard.getByTestId('shop-locked-stable')).toContainText('workshop')
  await shot(page, 'yard-build-desktop')

  // Furnish: the chips sort by where a piece goes; a stool is bought.
  await yard.getByRole('tab', { name: 'Furnish' }).click()
  await expect(yard.getByTestId('yard-counter')).toContainText(SILAS_YARD.tabQuotes.furnish)
  await expect(yard.locator('[data-buy="lantern-post"]')).toHaveCount(0)
  await yard.locator('[data-filter="outdoor"]').click()
  await expect(yard.locator('[data-buy="reading-chair"]')).toHaveCount(0)
  await expect(yard.locator('[data-buy="wooden-stool"]')).toHaveCount(1)
  await yard.locator('[data-filter="all"]').click()
  // A piece waiting on the cottage says so.
  await expect(yard.locator('[data-buy="reading-chair"]')).toHaveText('Needs the cottage')
  await yard.locator('[data-buy="wooden-stool"]').click()
  await expect(yard.locator('.msg.ok')).toContainText('Wooden Stool is yours')
  await expect.poll(async () => (await myHome(page)).items.map((i) => i.itemDef)).toContain('wooden-stool')
  await shot(page, 'yard-furnish-desktop')

  // Materials: three bundles, each capped a day, counted from the Glim log.
  await yard.getByRole('tab', { name: 'Materials' }).click()
  await expect(yard.locator('[data-bundle]')).toHaveCount(3)
  await expect(yard.getByTestId('left-timber')).toHaveText('3 of 3 left today')
  await yard.locator('[data-buy-bundle="timber"]').click()
  await expect(yard.locator('.msg.ok')).toContainText('Timber ×4 is yours')
  await expect(yard.getByTestId('left-timber')).toHaveText('2 of 3 left today')
  await expect(yard.getByTestId('yard-balance')).toContainText('8 timber')
  await shot(page, 'yard-materials-desktop')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Away from Silas: Mend says why, and its button stays shut.
  await go(page, 'commons', 23, 19)
  await openYard(page, 'mend')
  await expect(yard.getByRole('tab', { name: 'Mend' })).toHaveAttribute('aria-selected', 'true')
  await expect(yard.getByTestId('mend-away')).toHaveText(SILAS_YARD.mendAway)
  const mend = yard.locator(`[data-mend-at-silas="${brack}"]`)
  await expect(mend).toBeDisabled()
  await expect(mend).toHaveText('Silas is out')
  await shot(page, 'yard-mend-away-desktop')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Beside him: mended, at the mender's price.
  await bySilas(page)
  await openYard(page, 'mend')
  await expect(yard.getByTestId('mend-away')).toHaveCount(0)
  await expect(yard.locator(`[data-mend-row="brack-felling-axe"]`)).toContainText('2 timber, 1 wooden peg')
  await mend.click()
  await expect(yard.locator('.msg.ok')).toContainText('Silas mended the brack felling axe')
  await expect(yard.getByTestId('mend-none')).toBeVisible()
  await shot(page, 'yard-mended-desktop')
})

test('the Yard panel on a phone: four chips in one row, the portrait at 40 px, rows inside the screen', async ({ browser, baseURL }) => {
  test.setTimeout(150_000)
  const ctx = await browser.newContext({ baseURL, viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await freshPlayer(page, 'Tansy')
  await openYard(page, 'materials')
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const tabs = yard.getByRole('tab')
  await expect(tabs).toHaveCount(4)
  await expect(yard.locator('[data-bundle]')).toHaveCount(3)
  const boxes = await tabs.evaluateAll((all) => all.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), right: r.right, width: r.width, height: r.height })))
  // One row, inside the screen, each chip wide enough to read and to tap.
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1)
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(360)
  expect(Math.min(...boxes.map((b) => b.width))).toBeGreaterThanOrEqual(60)
  expect(Math.min(...boxes.map((b) => b.height))).toBeGreaterThanOrEqual(44)
  const portrait = yard.locator('.portrait')
  if ((await portrait.count()) > 0) expect((await portrait.boundingBox())!.width).toBeLessThanOrEqual(40)
  // Rows and buttons stay on the screen; nothing in the sheet scrolls sideways.
  const rights = await yard.locator('[data-bundle], [data-bundle] button').evaluateAll((all) => all.map((el) => el.getBoundingClientRect().right))
  expect(Math.max(...rights)).toBeLessThanOrEqual(360)
  expect(await yard.locator('.panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await shot(page, 'yard-phone')
  await ctx.close()
})

test('Manage your deed: offer to sign with someone at the table; then they give up their place', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnGlims(page, a)
  const gate = await claimDeed(page)
  const created = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  expect(created.ok()).toBe(true)
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const errors: string[] = []
  other.on('pageerror', (e) => errors.push(e.message))
  const b = await freshPlayer(other, 'Bram', code)

  // Away from the table: the panel says where to stand.
  await go(page, 'commons', 23, 19)
  await openDeed(page)
  const deed = page.getByRole('dialog', { name: DEED_PANEL_COPY.title })
  await expect(deed.getByTestId('deed-place')).toHaveText(DEED_PANEL_COPY.where('Tansy’s Place', `Lot ${gate + 1}`))
  await expect(deed.getByTestId('deed-names')).toHaveText(DEED_PANEL_COPY.onTheDeed('Tansy'))
  await expect(deed.getByTestId('deed-not-at-table')).toBeVisible()
  await deed.getByRole('button', { name: 'Close your deed' }).click()

  // Both at the table (presence: same room, within its radius).
  const t = HOMESTEAD_DATA.commons.silasTable
  await go(other, 'commons', Math.floor(t.x / 16), Math.floor(t.y / 16))
  await go(page, 'commons', Math.floor(t.x / 16), Math.floor(t.y / 16) + 1)
  const peers = (p: Page) => p.evaluate(() => (window as unknown as { __fsPresence: () => { peers: string[] } }).__fsPresence().peers)
  await expect.poll(() => peers(page), { timeout: 20_000 }).toContain(accountOf(b))
  await expect.poll(() => peers(other), { timeout: 20_000 }).toContain(accountOf(a))

  // Tansy offers the deed to Bram from the panel and signs her side.
  await openDeed(page)
  const bram = deed.locator(`[data-offer="${accountOf(b)}"]`)
  await expect(bram).toHaveText(DEED_PANEL_COPY.offer, { timeout: 15_000 })
  await shot(page, 'deed-share-desktop')
  await bram.click()
  await expect(deed.getByTestId('deed-message')).toContainText('Your name’s down')
  await expect.poll(async () => (await lane(other)).invites.length).toBe(1)
  await expect(deed.getByTestId('deed-offered')).toHaveText(DEED_PANEL_COPY.offered('Bram'), { timeout: 10_000 })

  // Bram has no home: he signs in the talk, at the table, within the window.
  await talk(other, /Talk to Silas/, /Sign Tansy’s deed/)
  await expect.poll(async () => (await homes(other)).myGate).toBe(gate)
  await expect(deed.getByTestId('deed-names')).toHaveText(DEED_PANEL_COPY.onTheDeed('Tansy, Bram'), { timeout: 15_000 })
  await deed.getByRole('button', { name: 'Close your deed' }).click()

  // Bram gives up his place from his own panel: Pell's confirm, then off the deed.
  await openDeed(other)
  const his = other.getByRole('dialog', { name: DEED_PANEL_COPY.title })
  await his.getByTestId('deed-give-up').click()
  const confirm = other.getByRole('alertdialog', { name: /Give up your place/ })
  await expect(confirm).toContainText(PELL_DEED.giveUpShared('Tansy & Bram’s Place'))
  await shot(other, 'deed-give-up-desktop')
  await confirm.getByRole('button', { name: PELL_DEED.giveUpConfirm }).click()
  await expect.poll(async () => (await lane(other)).mine).toBeNull()
  await expect(his).toHaveCount(0)
  await expectToast(other, /One line through it/)
  expect((await myHome(page)).members.map((m) => m.displayName)).toEqual(['Tansy'])
  expect(errors).toEqual([])
  await ctx.close()
})
