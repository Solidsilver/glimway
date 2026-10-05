import { expect, test, type Page } from './fixtures'
import { serverState } from './connected'
import { beginNewJourney } from './helpers'
import { atMyMailbox, claimDeed, earnPlenty, freshPlayer, fund, go, homes, intoCottage, myHome, onMyLand, place, readOn, shot, silasSays } from './home-helpers'
import { calendarAt } from '../src/lib/calendar'
import { dateLine } from '../src/lib/village'

/**
 * Phase 5 village life against the real Go server: the calendar, notice
 * boards and village projects, the workshop (storage chest, crafting
 * bench) and the mailbox. Fresh Habitica ids per test.
 */
test.use({ server: true })

type VillageView = { calendar: { wick: string; day: number; mark: string; festival: string | null }; source: string; worldFlags: string[]; projectsStatus: string }
const village = (page: Page) => page.evaluate(() => (window as unknown as { __fsVillage: () => VillageView }).__fsVillage())
const EPOCH = Date.parse('2026-01-05T00:00:00Z') / 1000

async function openBoard(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await go(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  const board = page.getByRole('dialog', { name: 'Notice Board' })
  await expect(board).toBeVisible()
  return board
}

async function giveAll(board: ReturnType<Page['getByRole']>, project: string): Promise<void> {
  const card = board.locator(`[data-project="${project}"]`)
  for (const all of await card.getByRole('button', { name: 'All' }).all()) await all.click()
  await card.locator(`[data-contribute="${project}"]`).click()
}

/** Claim a deed through Silas (and read his reply). */
async function claim(page: Page): Promise<void> {
  await claimDeed(page)
}

test('calendar: the HUD shows today in Hearthwick, and festivals dress the Commons', async ({ page }) => {
  await beginNewJourney(page)
  const c = calendarAt(Math.floor(Date.now() / 1000))
  await expect(page.getByTestId('calendar-line')).toContainText(`${dateLine(c)} — ${c.mark}`)
  expect((await village(page)).source).toBe('local')
  // Carting Day (Cart-wick, day 6), seen through the dev clock.
  await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), EPOCH + (5 * 7 + 5) * 86400 + 3600)
  await go(page, 'commons', 9, 21)
  await expect(page.getByTestId('calendar-line')).toContainText('Cart-wick, 6th day — Carting')
  await expect(page.getByTestId('calendar-line')).toContainText('Carting Day')
  await expect(page.locator('.toast', { hasText: 'Carting Day. Stalls on the Commons' })).toBeVisible({ timeout: 8000 })
  await shot(page, 'festival-carting-day-desktop')
  await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), EPOCH + (11 * 7 + 6) * 86400 + 3600)
  await go(page, 'village', 14, 12)
  await expect(page.getByTestId('calendar-line')).toContainText('Closure Night')
  await shot(page, 'festival-closure-night-desktop')
  await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), EPOCH + 12 * 7 * 86400 + 3600)
  await go(page, 'village', 34, 17)
  await expect(page.getByTestId('calendar-line')).toContainText('The Breaking')
  await shot(page, 'festival-the-breaking-desktop')
})

test('calendar: connected play reads the server’s calendar', async ({ page }) => {
  await freshPlayer(page)
  await expect.poll(async () => (await village(page)).source).toBe('server')
  const res = await page.request.get('/api/calendar')
  const cal = await res.json()
  await expect(page.getByTestId('calendar-line')).toContainText(`${cal.wick}-wick`)
  await expect(page.getByTestId('calendar-line')).toContainText(cal.mark)
})

test('notice board: Elara’s Turning notice, a guest is told to sign in', async ({ page }) => {
  await beginNewJourney(page)
  const board = await openBoard(page)
  await expect(board.getByTestId('turning-notice')).toContainText(/outer Wilds (will turn|turn at the dark)/)
  await expect(board).toContainText('Village projects are kept by your world')
  await expect(board.locator('[data-contribute]')).toHaveCount(0)
})

test('village projects: give materials, finish two, the village changes and a paper arrives', async ({ page }) => {
  const id = await freshPlayer(page)
  fund(id, { materials: { timber: 100, stone: 50, fiber: 30, amber: 30 } })
  let board = await openBoard(page)
  await expect(board.locator('.carried')).toContainText('100 timber')
  await shot(page, 'notice-board-desktop')
  // A part share first: your contribution shows.
  const canopy = board.locator('[data-project="well-canopy"]')
  await canopy.locator('[data-give="well-canopy:timber"]').fill('10')
  await canopy.locator('[data-contribute="well-canopy"]').click()
  await expect(canopy.locator('.msg.ok')).toContainText('10 given')
  await expect(canopy).toContainText('you: 10')
  await expect(canopy.locator('.stage')).toHaveText('Under way')
  // Then the rest: the well gets its canopy.
  await giveAll(board, 'well-canopy')
  await expect(canopy.locator('.msg.ok')).toContainText('Finished!')
  await expect(canopy.locator('.stage')).toHaveText('Done')
  await expect.poll(async () => (await village(page)).worldFlags).toContain('project:well-canopy:complete')
  // Ada's window: needs more fiber than we have; top up and come back.
  fund(id, { materials: { fiber: 40 } })
  await page.keyboard.press('Escape')
  board = await openBoard(page)
  await giveAll(board, 'cooley-window-fund')
  await expect(board.locator('[data-project="cooley-window-fund"] .msg.ok')).toContainText('Finished!')
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:adas-oil-receipts')
  await expect(board.locator('[data-project="cooley-window-fund"] .papers')).toContainText('In your journal')
  // Over-asking is refused before or by the server, never silently clamped.
  const bridge = board.locator('[data-project="north-bridge"]')
  await bridge.locator('[data-give="north-bridge:timber"]').fill('9999')
  await expect(bridge.locator('[data-give="north-bridge:timber"]')).toHaveValue(/^(0|1?\d|[1-9]\d)$/)
  await page.keyboard.press('Escape')
  await go(page, 'village', 13, 14)
  await shot(page, 'village-changes-desktop')
})

test('workshop: Silas builds it on; store and take out at the chest; make things at the bench', async ({ page }) => {
  test.setTimeout(process.env.SCREENS ? 300_000 : 180_000)
  const id = await freshPlayer(page)
  await earnPlenty(page, id)
  fund(id, { materials: { timber: 60, stone: 30, fiber: 30, amber: 5 } })
  await claim(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
  await page.waitForTimeout(400)
  await silasSays(page, /Build on a workshop/)
  await readOn(page, /Steady|eaves/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(2)
  await onMyLand(page, 2, 2)
  await shot(page, 'land-workshop-desktop')
  await intoCottage(page)

  // The chests: the home chest everyone on the deed shares, and your own.
  await place(page, 40, 66)
  await expect(page.locator('.prompt')).toContainText('Open the chests')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  const panel = page.getByRole('dialog', { name: 'The Workshop' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-goods="material:timber"]')).toContainText('40')
  await panel.locator('[data-store="timber:5"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Stored 5 timber')
  await shot(page, 'storage-chest-desktop')
  let st = await (await page.request.get('/api/storage')).json()
  expect(st.storage.materials.timber).toBe(5)
  await panel.locator('[data-take="timber:1"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Took out 1 timber')
  st = await (await page.request.get('/api/storage')).json()
  expect(st.storage.materials.timber).toBe(4)
  // Your own chest: small, yours alone, and it goes with you if you ever leave the deed.
  await panel.locator('[data-chest="personal"]').click()
  await panel.locator('[data-store="timber:5"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Stored 5 timber (your own chest)')
  await expect(panel.locator('[data-chest="personal"]')).toContainText('5/')
  await shot(page, 'personal-chest-desktop')
  st = await (await page.request.get('/api/storage')).json()
  expect(st.personal.materials.timber).toBe(5)
  expect(st.storage.materials.timber).toBe(4)

  // The crafting bench.
  await panel.getByRole('tab', { name: 'Crafting bench' }).click()
  await expect(panel.locator('[data-recipe="craft-wooden-peg"]')).toContainText('You can make')
  await panel.locator('[data-craft="craft-wooden-peg"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made a Wooden Peg')
  await panel.locator('[data-craft="craft-wooden-stool"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made a Wooden Stool')
  await shot(page, 'crafting-bench-desktop')
  st = await (await page.request.get('/api/storage')).json()
  expect(st.inventory.items['wooden-peg']).toBe(1)
  expect(st.inventory.decorations['wooden-stool']).toBe(1)
  // No amber for an oak table? It says so plainly.
  await expect(panel.locator('[data-recipe="craft-amber-sconce"]')).toContainText(/You can make|Not enough materials/)
})

test('mailbox: send a neighbour materials, they collect it; sent mail is recalled', async ({ page, browser, baseURL }) => {
  test.setTimeout(process.env.SCREENS ? 300_000 : 180_000)
  const a = await freshPlayer(page, 'Tansy')
  await claim(page)
  fund(a, { materials: { timber: 10 }, items: { 'tin-whistle': 1 } })
  const created = await page.request.post('/api/invites', { data: {} })
  const code = (await created.json()).code as string

  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const errors: string[] = []
  other.on('pageerror', (e) => errors.push(e.message))
  const b = await freshPlayer(other, 'Bram', code)
  await claim(other)

  // Tansy posts 3 timber from her own mailbox (by the path on her land).
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).gates.filter((g) => g.names.length > 0).length).toBeGreaterThanOrEqual(2)
  await atMyMailbox(page)
  await expect(page.locator('.prompt')).toContainText('Check your mailbox')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  const mail = page.getByRole('dialog', { name: 'Mailbox' })
  await mail.getByRole('tab', { name: 'Send something' }).click()
  await mail.getByTestId('mail-to').selectOption({ label: 'Bram' })
  await mail.locator('[data-pick="material:timber"]').click()
  await mail.getByTestId('mail-qty').fill('3')
  await shot(page, 'mailbox-send-desktop')
  await mail.getByTestId('mail-send').click()
  await expect(mail.locator('.msg.ok')).toContainText('Sent 3 timber to Bram')
  // And the whistle, which she then takes back.
  await mail.locator('[data-pick="item:tin-whistle"]').click()
  await mail.getByTestId('mail-send').click()
  await expect(mail.locator('.msg.ok')).toContainText('Sent a Tin Whistle')
  await mail.getByRole('tab', { name: 'Your mail' }).click()
  await expect(mail.locator('[data-sent]')).toHaveCount(2)
  const whistle = mail.locator('[data-sent]', { hasText: 'Tin Whistle' })
  await whistle.getByRole('button', { name: 'Recall' }).click()
  await expect(mail.locator('.msg.ok')).toContainText('A Tin Whistle came back to you')
  const back = await (await page.request.get('/api/mail')).json()
  expect(back.inventory.items['tin-whistle']).toBe(1)
  expect(back.mail.find((m: { asset: { id: string } }) => m.asset.id === 'tin-whistle').returnReason).toBe('recalled')
  await expect(mail.locator('[data-sent]')).toHaveCount(1)
  await mail.locator('summary').click()
  await expect(mail.locator('.history')).toContainText('Tin Whistle · recalled')
  await page.keyboard.press('Escape')

  // Bram's flag is up; he collects the timber.
  await go(other, 'commons', 23, 19)
  await expect.poll(async () => (await homes(other)).status).toBe('ready')
  await atMyMailbox(other)
  await shot(other, 'mailbox-flag-desktop')
  await expect(other.locator('.prompt')).toContainText('Check your mailbox')
  await other.waitForTimeout(200)
  await other.keyboard.press('e')
  const box = other.getByRole('dialog', { name: 'Mailbox' })
  const parcel = box.locator('[data-mail]', { hasText: '3 timber' })
  await expect(parcel).toContainText('from Tansy')
  await shot(other, 'mailbox-collect-desktop')
  await parcel.getByRole('button', { name: 'Collect' }).click()
  await expect(box.locator('.msg.ok')).toContainText('You collect 3 timber from Tansy')
  const got = await (await other.request.get('/api/mail')).json()
  expect(got.inventory.materials.timber).toBe(3)
  expect(got.mail.find((m: { asset: { id: string } }) => m.asset.id === 'timber').claimedAt).not.toBeNull()
  void b
  expect(errors).toEqual([])
  await ctx.close()
})
