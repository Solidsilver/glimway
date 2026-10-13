import type { Locator } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, CONTRACT, serverState, sql } from './connected'
import { AT_COUNTER, AT_PELL, BY_DESK, DEED_BOUGHT, DEEDS, YARD, claimDeed, earnGlims, freshPlayer, fund, giveInstance, go, homes, lane, myHome, readOn, shot, silasPresent, talk } from './home-helpers'
import { dialogueState, expectAreaCard, expectToast, frames, readDialogue, untilChoices, waitForArea, waitForLive, animationsDone } from './helpers'
import { setHour } from './room-helpers'
import { SILAS_YARD } from '../src/content/expansion-writing.ts'
import { DEED_PANEL_COPY, PELL, PELL_DEED } from '../src/content/pell.ts'
import { glimsCount } from '../src/content/purse.ts'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import { itemDef } from '../src/lib/items.ts'
import { residentAt } from '../src/lib/residents.ts'

/**
 * Silas's Yard (silas-yard.md 2.5, 2.6), against the real Go server: the
 * Yard panel's four tabs (a buy on Furnish and on Materials, Mend refused
 * while Silas is out of reach, then done beside him for his glims), and
 * Pell's Manage your deed panel (offering at the deed table, a signature
 * waiting on you signed back at the table, then giving up a place). The
 * panels open through their entry points (src/game/yard-open.ts emits these
 * events). The walk-in Yard: in at the front door, Silas's short talk at his
 * counter, Pell's first deed through the side door, a display opening its
 * tab, and the tin while Silas is out.
 *
 * SCREENS=1 also saves review screenshots to .agent/screens/.
 */

const openYard = (page: Page, tab?: string) => page.evaluate((t) => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('ui:home-shop', t ? { tab: t } : {}), tab)
const openDeed = (page: Page) => page.evaluate(() => (window as unknown as { __fsEmit: (e: string) => void }).__fsEmit('ui:home-deed'))
const quests = (page: Page) => page.evaluate(() => (window as unknown as { __fsQuests: () => { goal: unknown } }).__fsQuests())
const needle = (page: Page) => page.evaluate(() => (window as unknown as { __fsGoal: () => { dir: { angle: number | null; here: boolean } } }).__fsGoal())
const reloadItems = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
const glimsOf = async (page: Page) => {
  const n = (await serverState(page)).body?.state?.glims
  expect(typeof n).toBe('number')
  return n as number
}

/**
 * Silas out in his yard by the sawhorse (his cycle at minute 10, both clocks
 * set), and you beside him: his goods and his mending both reach you there.
 */
async function silasOutside(page: Page): Promise<{ area: string; tx: number; ty: number }> {
  const at = residentAt('silas', await setHour(page, { minute: 10, server: true }))!
  expect(at.area).toBe('commons')
  return at
}

/** Every box inside a 360 px screen, and nothing in the sheet scrolling sideways. */
async function fitsPhone(panel: Locator, selector: string): Promise<void> {
  const rights = await panel.locator(selector).evaluateAll((all) => all.map((el) => el.getBoundingClientRect().right))
  expect(rights.length).toBeGreaterThan(0)
  expect(Math.max(...rights)).toBeLessThanOrEqual(360)
  expect(await panel.locator('.panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
}

test('the Yard panel: Build first while the cottage is to raise, a buy on Furnish and Materials, Mend only beside Silas', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Tansy')
  await earnGlims(page, id)
  await claimDeed(page)
  const brack = giveInstance(id, 'brack-felling-axe', { uses: 0, max: 240 })
  fund(id, { materials: { timber: 4 } })
  await reloadItems(page)
  const silas = await silasOutside(page)
  await go(page, silas.area, silas.tx, silas.ty + 1)

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

  // Beside him: mended, and his glims taken (the materials stay in the pack).
  await go(page, silas.area, silas.tx, silas.ty + 1)
  const price = itemDef('brack-felling-axe')!.repair!.menderGlims!
  const before = await glimsOf(page)
  await openYard(page, 'mend')
  await expect(yard.getByTestId('mend-away')).toHaveCount(0)
  await expect(yard.locator(`[data-mend-row="brack-felling-axe"]`)).toContainText(glimsCount(price))
  await mend.click()
  await expect(yard.locator('.msg.ok')).toContainText('Silas mended the brack felling axe')
  await expect(yard.getByTestId('mend-none')).toBeVisible()
  expect(await glimsOf(page)).toBe(before - price)
  await expect(yard.getByTestId('yard-balance')).toContainText(`${before - price} glims`)
  await expect(yard.getByTestId('yard-balance')).toContainText('8 timber')
  await shot(page, 'yard-mended-desktop')
})

test('the Yard and deed panels on a phone: four chips in one row, a 40 px portrait, every tab and the deed inside the screen', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const ctx = await browser.newContext({ baseURL, viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const id = await freshPlayer(page, 'Tansy')
  await earnGlims(page, id)
  await claimDeed(page)
  giveInstance(id, 'brack-felling-axe', { uses: 0, max: 240 })
  await reloadItems(page)

  await openYard(page, 'materials')
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const tabs = yard.getByRole('tab')
  await expect(tabs).toHaveCount(4)
  await expect(yard.locator('[data-bundle]')).toHaveCount(3)
  // Measure the full-sized controls after the opening scale/slide animation.
  await animationsDone(page)
  const boxes = await tabs.evaluateAll((all) => all.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), right: r.right, width: r.width, height: r.height })))
  // One row, inside the screen, each chip wide enough to read and to tap.
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1)
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(360)
  expect(Math.min(...boxes.map((b) => b.width))).toBeGreaterThanOrEqual(60)
  expect(Math.min(...boxes.map((b) => b.height))).toBeGreaterThanOrEqual(44)
  expect((await yard.locator('.portrait').boundingBox())!.width).toBeLessThanOrEqual(40)
  await fitsPhone(yard, '[data-bundle], [data-bundle] button')
  await shot(page, 'yard-phone')

  // Build: the cottage row and the buildings, their buttons on the screen.
  await yard.getByRole('tab', { name: 'Build' }).click()
  await expect(yard.getByTestId('yard-upgrade')).toBeVisible()
  await fitsPhone(yard, '[data-testid="yard-upgrade"], [data-testid="yard-upgrade"] button, [data-testid="shop-buildings"] li, [data-testid="shop-buildings"] button')
  await shot(page, 'yard-build-phone')

  // Furnish, with its chips.
  await yard.getByRole('tab', { name: 'Furnish' }).click()
  await expect(yard.locator('[data-buy="wooden-stool"]')).toHaveCount(1)
  await fitsPhone(yard, '[data-filter], [data-buy]')

  // Mend: the worn axe's row and its (shut) button.
  await yard.getByRole('tab', { name: 'Mend' }).click()
  await expect(yard.locator('[data-mend-row]')).toHaveCount(1)
  await fitsPhone(yard, '[data-mend-row], [data-mend-row] button, [data-testid="mend-away"]')
  await shot(page, 'yard-mend-phone')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // The deed panel: the place, the table note and Give up, all on the screen.
  await openDeed(page)
  const deed = page.getByRole('dialog', { name: DEED_PANEL_COPY.title })
  await expect(deed.getByTestId('deed-place')).toBeVisible()
  await fitsPhone(deed, '[data-testid="deed-place"], [data-testid="deed-names"], [data-testid="deed-not-at-table"], [data-testid="deed-give-up"]')
  await animationsDone(page)
  expect((await deed.getByTestId('deed-give-up').boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await shot(page, 'deed-phone')
  await ctx.close()
})

test('Manage your deed: offer at the table; a signature waiting on you, signed back at the table; then they give up their place', async ({ page, browser, baseURL }) => {
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
  const close = () => deed.getByRole('button', { name: 'Close your deed' }).click()
  await close()

  // Both at the table (presence: same room, within its radius): Bram by Pell's desk, Tansy across the table.
  const t = HOMESTEAD_DATA.commons.deedTable
  const toTable = () => go(page, t.area, Math.floor(t.x / 16), Math.floor(t.y / 16) + 1)
  await go(other, t.area, AT_PELL.tx, AT_PELL.ty)
  await toTable()
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
  await close()

  // Right of Pell's desk, Pell talks but the table is out of reach: the
  // sign choice shows, disabled, and says where to stand.
  await go(other, DEEDS, BY_DESK.tx, BY_DESK.ty)
  await expect(other.locator('.prompt')).toContainText('Talk to Pell')
  await waitForLive(other)
  await other.keyboard.press('e')
  // Pell reads the plot book first (the world holds still), then talks.
  const pellTalk = other.getByRole('dialog', { name: /Conversation with/ })
  await expect(pellTalk).toBeVisible()
  const byDesk = await untilChoices(other)
  expect(byDesk.find((c) => c.text === 'Sign Tansy’s deed')?.disabled).toBe(true)
  await expect(pellTalk).toContainText(PELL_DEED.standByTable)
  await readDialogue(other, { pick: new RegExp(PELL_DEED.notToday) })

  // Her signature lapses before Bram signs: he signs in Pell's talk, at the
  // table, and the deed waits on hers.
  await go(other, DEEDS, AT_PELL.tx, AT_PELL.ty)
  const windowS = HOMESTEAD_DATA.jointDeed.confirmWindowSeconds
  sql(`UPDATE homestead_invites SET from_confirmed_at = from_confirmed_at - ${windowS + 30} WHERE to_id = '${accountOf(b)}';`)
  await talk(other, /Talk to Pell/, /Sign Tansy’s deed/)
  await expect.poll(() => sql(`SELECT to_confirmed_at FROM homestead_invites WHERE to_id = '${accountOf(b)}';`)).not.toBe('')
  expect((await lane(other)).mine).toBeNull()

  // "Waiting for you": Tansy signs it back, but only at the table.
  await go(page, 'commons', 23, 19)
  await openDeed(page)
  const back = deed.locator(`[data-sign-back="${accountOf(b)}"]`)
  await expect(back).toContainText('Bram has signed', { timeout: 10_000 })
  await expect(back.getByRole('button', { name: DEED_PANEL_COPY.sign })).toBeDisabled()
  await expect(back.getByTestId('deed-sign-why')).toHaveText('Sign at the deed table.')
  await shot(page, 'deed-waiting-away-desktop')
  await close()
  await toTable()
  await expect.poll(() => peers(page), { timeout: 20_000 }).toContain(accountOf(b))
  await openDeed(page)
  await expect(back.getByRole('button', { name: DEED_PANEL_COPY.sign })).toBeEnabled({ timeout: 10_000 })
  await expect(back.getByTestId('deed-sign-why')).toHaveCount(0)
  await back.getByRole('button', { name: DEED_PANEL_COPY.sign }).click()
  await expect(deed.getByTestId('deed-message')).toContainText(PELL_DEED.signedTogether)
  await expect.poll(async () => (await lane(other)).mine?.gate).toBe(gate)
  await expect(deed.getByTestId('deed-names')).toHaveText(DEED_PANEL_COPY.onTheDeed('Tansy, Bram'), { timeout: 15_000 })
  await expect(deed.getByTestId('deed-waiting')).toHaveCount(0)
  await close()

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

test('the walk-in Yard: in at the front door, Silas’s short talk, Pell’s first deed through the side door, a display, and the tin while he’s out', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Tansy')
  await earnGlims(page, id)
  const brack = giveInstance(id, 'brack-felling-axe', { uses: 0, max: 240 })
  await reloadItems(page)
  // Silas behind his counter (minute 30 of his hour), on both clocks.
  await setHour(page, { minute: 30, server: true })

  // The front door under his sign on the Commons: in, without a knock. He's
  // not by the sawhorse while his hour has him inside.
  await go(page, 'commons', 53, 18)
  expect(await silasPresent(page), 'no Silas on the Commons at minute 30').toBe(false)
  await expect(page.locator('.prompt')).toContainText(/Go into Silas.s Yard/)
  await waitForLive(page)
  await page.keyboard.press('e')
  await waitForArea(page, YARD)
  await expectAreaCard(page, 'Silas’s Yard')
  await shot(page, 'yard-walk-in-desktop')

  // Silas at the counter: his line, the pointer to Pell (no deed yet), and two choices.
  await go(page, YARD, AT_COUNTER.tx, AT_COUNTER.ty)
  expect(await silasPresent(page), 'Silas at his counter at minute 30').toBe(true)
  await expect(page.locator('.prompt')).toContainText('Talk to Silas')
  await waitForLive(page)
  await page.keyboard.press('e')
  // He finds your page in the plot book first (the world holds still), then talks.
  const conversation = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(conversation).toBeVisible()
  const choices = await untilChoices(page)
  expect(choices.map((c) => c.text)).toEqual([SILAS_YARD.seeTheYard, SILAS_YARD.justPassing])
  expect((await dialogueState(page)).said.join(' ')).toContain(SILAS_YARD.pellPointer)
  await readDialogue(page, { pick: /See the Yard/ })
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(yard).toBeVisible()
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()
  // The needle points at Pell now (the claim guide, pinned since nothing else was).
  await expect(page.getByTestId('goal-pinned')).toContainText('Pell')
  // Only the first time: unpinned, it stays unpinned when he points again.
  await page.getByTestId('goal-pinned').click()
  await page.getByTestId('pin-claim').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('goal-pinned')).toHaveCount(0)
  await talk(page, /Talk to Silas/, /Just passing/)
  expect((await dialogueState(page)).said.join(' ')).toContain(SILAS_YARD.pellPointer)
  await expect(page.getByTestId('goal-pinned')).toHaveCount(0)

  // The mending bench, four tiles from him, opens Mend, and he mends from
  // behind the counter: the whole shop is in his reach while he's in.
  await go(page, YARD, 11, 3)
  await expect(page.locator('.prompt')).toContainText(SILAS_YARD.spots.mend)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(yard.getByRole('tab', { name: 'Mend' })).toHaveAttribute('aria-selected', 'true')
  await expect(yard.getByTestId('mend-away')).toHaveCount(0)
  await yard.locator(`[data-mend-at-silas="${brack}"]`).click()
  await expect(yard.locator('.msg.ok')).toContainText('Silas mended the brack felling axe')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // A display opens its own tab.
  await go(page, YARD, 2, 3)
  await expect(page.locator('.prompt')).toContainText(SILAS_YARD.spots.materials)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(yard.getByRole('tab', { name: 'Materials' })).toHaveAttribute('aria-selected', 'true')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Through the side door to Pell's office.
  await go(page, YARD, 12, 5)
  await page.keyboard.down('ArrowRight')
  await waitForArea(page, DEEDS)
  await page.keyboard.up('ArrowRight')
  await expectAreaCard(page, 'Pell’s office')

  // Pell: the first meeting, with the first deed (free, on the Compact).
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  const free = (await homes(page)).gates.find((g) => g.homeId === null)!
  await go(page, DEEDS, AT_PELL.tx, AT_PELL.ty)
  await expect(page.locator('.prompt')).toContainText('Talk to Pell')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(conversation).toBeVisible()
  const deeds = await untilChoices(page)
  expect((await dialogueState(page)).said.join(' ')).toContain(PELL.firstMeeting.lines[0])
  expect(deeds.at(-1)!.text).toBe(PELL_DEED.notToday)
  expect(deeds.find((c) => c.text === `The deed to Lot ${free.gate + 1}`)).toBeTruthy()
  await shot(page, 'yard-pell-desktop')
  await readDialogue(page, { pick: new RegExp(`The deed to Lot ${free.gate + 1}`) })
  await expect.poll(async () => (await homes(page)).myGate).toBe(free.gate)
  await readOn(page, DEED_BOUGHT)
  // The toast says where the gate is, and the needle leads out of the Yard to it.
  await expectToast(page, /Your gate is out on the lane: follow the marker/)
  await expect.poll(async () => (await quests(page)).goal).toEqual({ kind: 'guide', where: 'gate' })
  await waitForLive(page)
  await frames(page, 30)
  expect((await needle(page)).dir.here).toBe(false)
  expect(Math.cos((await needle(page)).dir.angle!), 'toward the side door: west').toBeLessThan(-0.3)
  // Mending isn't Pell's: out of Silas's reach in the office.
  await openYard(page, 'mend')
  await expect(yard.getByTestId('mend-away')).toBeVisible()
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Back through the side door; Silas steps out to the sawhorse (minute 10).
  await go(page, DEEDS, 1, 3)
  await page.keyboard.down('ArrowLeft')
  await waitForArea(page, YARD)
  await page.keyboard.up('ArrowLeft')
  await setHour(page, { minute: 10, server: true })
  await go(page, YARD, AT_COUNTER.tx, AT_COUNTER.ty)
  expect(await silasPresent(page), 'no Silas at his counter at minute 10').toBe(false)
  // The counter: the tin, and the panel still sells.
  await talk(page, new RegExp(SILAS_YARD.spots.counter), /See the Yard/)
  expect((await dialogueState(page)).said.join(' ')).toContain(SILAS_YARD.tin)
  await expect(yard).toBeVisible()
  await yard.getByRole('tab', { name: 'Materials' }).click()
  await yard.locator('[data-buy-bundle="timber"]').click()
  await expect(yard.locator('.msg.ok')).toContainText('Timber ×4 is yours')
  await shot(page, 'yard-tin-desktop')
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()

  // Out on the Commons he's by the sawhorse; the needle now follows the gate's marker.
  await go(page, 'commons', 53, 18)
  expect(await silasPresent(page), 'Silas by the sawhorse at minute 10').toBe(true)
  await expect.poll(async () => (await quests(page)).goal).not.toEqual({ kind: 'guide', where: 'gate' })
})
