import { expect, test, type Page } from './fixtures'
import { linkStatus, serverState } from './connected'
import { beginNewJourney } from './helpers'
import { atMyMailbox, claimDeed, earnEmbers, earnPlenty, freshPlayer, fund, go, homes, intoCottage, myHome, place, readOn, silasSays } from './home-helpers'

/**
 * Regressions for the phase 5 review (.agent/REVIEW-5.md), against the real
 * Go server: unreadable answers, stale carried balances, stale homes after
 * mail recovery, the craft batch mismatch, and the calendar across midnight.
 */
test.use({ server: true })

const EPOCH = Date.parse('2026-01-05T00:00:00Z') / 1000

async function claim(page: Page): Promise<void> {
  await claimDeed(page)
}

/** Let the server commit the next matching POST, then hand the page a broken body. */
async function truncateNextAnswer(page: Page, path: string, times = 1): Promise<void> {
  let left = times
  await page.route(`**${path}`, async (route) => {
    if (left <= 0 || route.request().method() !== 'POST') return route.continue()
    left -= 1
    const res = await route.fetch()
    const text = await res.text()
    await route.fulfill({ status: 200, contentType: 'application/json', body: text.slice(0, 40) })
  })
}

async function loseNextAnswer(page: Page, path: string): Promise<void> {
  let done = false
  await page.route(`**${path}`, async (route) => {
    if (done || route.request().method() !== 'POST') return route.continue()
    done = true
    await route.fetch()
    await route.abort('failed')
  })
}

test('finding 2: a 200 with a truncated body is replayed with the same key, never a second purchase', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await claim(page)
  const before = (await serverState(page)).body.state.embers
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  const keys: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/homestead/buy')) keys.push(JSON.parse(r.postData() ?? '{}').key)
  })

  // Once unreadable: the same request is asked again at once and completes.
  await truncateNextAnswer(page, '/api/homestead/buy', 1)
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toContainText('Wooden Stool is yours')
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  expect((await myHome(page, id)).items.filter((i) => i.itemDef === 'wooden-stool')).toHaveLength(1)
  expect((await serverState(page)).body.state.embers).toBe(before - 2)
  await page.unrouteAll({ behavior: 'wait' })

  // Unreadable twice: the outcome is unknown; asking again resolves it, not a third stool.
  await truncateNextAnswer(page, '/api/homestead/buy', 2)
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.error')).toContainText('may have gone through')
  await expect(shop.locator('.msg.error')).not.toContainText('Nothing changed')
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg')).toContainText('went through after all')
  expect(new Set(keys.slice(2)).size).toBe(1)
  expect((await myHome(page, id)).items.filter((i) => i.itemDef === 'wooden-stool')).toHaveLength(2)
  expect((await serverState(page)).body.state.embers).toBe(before - 4)
  await expect.poll(async () => (await homes(page)).mine?.items.length).toBe(2)
})

test('finding 3: giving to a project updates the board’s carried balance at once', async ({ page }) => {
  const id = await freshPlayer(page)
  fund(id, { materials: { timber: 10 } })
  await go(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  const board = page.getByRole('dialog', { name: 'Notice Board' })
  await expect(board.locator('.carried')).toContainText('10 timber')
  const canopy = board.locator('[data-project="well-canopy"]')
  await canopy.locator('[data-give="well-canopy:timber"]').fill('8')
  await canopy.locator('[data-contribute="well-canopy"]').click()
  await expect(canopy.locator('.msg.ok')).toContainText('8 given')
  await expect(board.locator('.carried')).toContainText('2 timber')
  // And the next project can't be offered goods that were just given.
  const bridge = board.locator('[data-project="north-bridge"]')
  await bridge.locator('tr', { hasText: 'Timber' }).getByRole('button', { name: 'All' }).click()
  await expect(bridge.locator('[data-give="north-bridge:timber"]')).toHaveValue('2')
})

test('finding 4: a lost parcel send of a piece leaves Arrange showing it gone once recovered', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const a = await freshPlayer(page, 'Tansy')
  await earnEmbers(page, a)
  await claim(page)
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toBeVisible()
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  const code = (await (await page.request.post('/api/invites', { data: {} })).json()).code as string
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  await freshPlayer(other, 'Bram', code)
  // Mail goes between homesteads: Bram takes up a deed too.
  await claimDeed(other)
  await ctx.close()

  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).gates.filter((g) => g.names.length > 0).length).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => (await homes(page)).mine?.items.length).toBe(1)
  await atMyMailbox(page)
  await expect(page.locator('.prompt')).toContainText('Check your mailbox')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  const mail = page.getByRole('dialog', { name: 'Mailbox' })
  await mail.getByRole('tab', { name: 'Send something' }).click()
  await mail.getByTestId('mail-to').selectOption({ label: 'Bram' })
  await mail.locator('[data-pick="decoration:wooden-stool"]').click()
  await loseNextAnswer(page, '/api/mail')
  await mail.getByTestId('mail-send').click()
  await expect(mail.locator('.msg.error')).toContainText('may have gone through')
  await page.keyboard.press('Escape')
  await expect(page.locator('.toast', { hasText: 'parcel went through after all' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => linkStatus(page)).toBe('online')
  expect((await myHome(page, a)).items).toHaveLength(0)
  // The client's home agrees by the time recovery is announced.
  expect((await homes(page)).mine?.items).toHaveLength(0)
})

test('finding 5: crafting sends the batch it shows, after the stock runs low', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page)
  await earnPlenty(page, id)
  fund(id, { materials: { timber: 60, stone: 30, fiber: 30 } })
  await claim(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
  await page.waitForTimeout(400)
  await silasSays(page, /Build on a workshop/)
  await readOn(page, /eaves/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(2)
  fund(id, { materials: { timber: 12 } })
  await intoCottage(page)
  await place(page, 115, 66)
  await expect(page.locator('.prompt')).toContainText('Work at the bench')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  const panel = page.getByRole('dialog', { name: 'The Workshop' })
  const stool = panel.locator('[data-recipe="craft-wooden-stool"]')
  await expect(stool).toContainText('You can make 4')
  await stool.getByRole('button', { name: 'More' }).click()
  await stool.getByRole('button', { name: 'More' }).click()
  await expect(stool.locator('.cost')).toContainText('9 timber for 3')
  await stool.locator('[data-craft="craft-wooden-stool"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made 3 Wooden Stools')
  // Three timber left: one stool shown, one stool made.
  await expect(stool).toContainText('You can make 1')
  await expect(stool.locator('.cost')).toHaveText('3 timber')
  await stool.locator('[data-craft="craft-wooden-stool"]').click()
  await expect(panel.locator('.msg.ok')).toContainText('Made a Wooden Stool')
})

test('finding 6: the date turns at midnight without leaving the scene', async ({ page }) => {
  await beginNewJourney(page)
  // 8 seconds before the end of Bud-wick (the 3rd wick): its last day.
  const t = EPOCH + 3 * 7 * 86400 - 8
  await page.evaluate((x) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(x), t)
  await expect(page.getByTestId('calendar-line')).toContainText('Bud-wick, 7th day — Mudrise')
  await expect(page.getByTestId('calendar-line')).toContainText('Bloom-wick, 1st day — Carting', { timeout: 15_000 })
})
