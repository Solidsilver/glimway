import type { Browser, BrowserContext } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, allow, CONTRACT, habiticaURL, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, sql, TOKEN, waitForWorld } from './connected'
import { expectToast, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'
import { residentsOut } from './room-helpers'
import { atMyMailbox, claimDeed, earnEmbers, freshPlayer, fund, go, homes, myHome, place, readOn, shot, silasSays, type HomesView } from './home-helpers'

/**
 * The gold purse in the game (docs/design/purse-and-wardrobe.md 2, 3; the
 * e2e list in 10.2): a top-up against the fake Habitica (moved, not enough,
 * a score that times out and a check that confirms it), buying flour from
 * Finn with gold, a priced shelf slot a friend buys, a gold letter sent,
 * collected and recalled, and gold handed over in the square.
 *
 * The first test needs only the client: the consent card. The rest need the
 * server lanes (B: the top-up, `PlayerState.purse`, `GET /api/purse` and the
 * fake Habitica's gold; C: gold buys, shelves, letters and gives). Gold for
 * spending is put in the purse directly (`seedGold`), as the dev tools put
 * embers in, so those tests don't depend on a top-up.
 */

/**
 * The fake Habitica's gold and its score switch (lane B, e2e/server/
 * fake-habitica.ts): `gp` is the hero's Habitica gold; `score: 'timeout-moved'`
 * makes the score take the gold and then not answer in time, so the
 * worker's balance check has to confirm it. The names are lane D's guess at
 * lane B's switches: keep them in step.
 */
async function habitica(id: string, o: { gp?: number; score?: 'ok' | 'timeout-moved' }): Promise<void> {
  const res = await fetch(`${habiticaURL()}/__user`, { method: 'POST', body: JSON.stringify({ id, ...o }) })
  expect(res.ok).toBe(true)
}

/** What the fake Habitica says the hero's gold is now. */
async function habiticaGold(id: string): Promise<number> {
  const res = await fetch(`${habiticaURL()}/api/v3/user`, { headers: { 'x-api-user': id, 'x-api-key': TOKEN } })
  return Math.floor((await res.json()).data.stats.gp)
}

/** Gold in the purse without a top-up (both sides of the ledger, as a top-up writes them). */
function seedGold(id: string, gold: number): void {
  const a = accountOf(id)
  sql(`UPDATE balances SET gold = gold + ${gold} WHERE account_id = '${a}';
       INSERT INTO ledger (account_id, currency, delta, earned_delta, reason, ref, created_at)
       VALUES ('${a}', 'gold', ${gold}, 0, 'test-grant', 'e2e', unixepoch());
       UPDATE players SET version = version + 1 WHERE account_id = '${a}';`)
}

/** The purse as the server keeps it. */
function purseOf(id: string): number {
  return Number(sql(`SELECT gold FROM balances WHERE account_id = '${accountOf(id)}';`))
}

/** The purse the game shows (the HUD's and the card's number). */
const shownGold = (page: Page) => page.evaluate(() => (window as unknown as { __fsPurse: () => { gold: number } | null }).__fsPurse()?.gold ?? null)

/** Read the purse again (a seeded purse shows after a state read). */
async function rereadState(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fsPurse: { reread: () => Promise<void> } }).__fsPurse.reread())
}

const menu = (page: Page) => page.getByRole('dialog', { name: 'Menu' })

async function openMenu(page: Page): Promise<void> {
  if (!(await menu(page).isVisible())) await page.keyboard.press('Escape')
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByTestId('purse-card')).toBeVisible()
}

/** Menu → Top up from Habitica (it syncs first) → the consent card. */
async function openConsent(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await openMenu(page)
  await menu(page).getByTestId('purse-top-up').click()
  const card = page.getByRole('dialog', { name: 'Move gold into your purse' })
  await expect(card).toBeVisible()
  return card
}

/** The purse log's lines, as the sheet shows them. */
async function logLines(page: Page): Promise<string[]> {
  await openMenu(page)
  await menu(page).getByTestId('purse-log-open').click()
  const sheet = page.getByRole('dialog', { name: 'Purse log' })
  await expect(sheet.getByTestId('purse-log')).toBeVisible()
  const lines = await sheet.locator('.entry').allInnerTexts()
  await sheet.getByLabel('Close the purse log').click()
  return lines.map((l) => l.replace(/\s+/g, ' ').trim())
}

async function twoPlayers(page: Page, browser: Browser, baseURL: string, names: [string, string]): Promise<{ other: Page; ctx: BrowserContext; a: string; b: string }> {
  const a = newUser()
  const b = newUser()
  allow(a)
  await setHabitica(a, { name: names[0] })
  await setHabitica(b, { name: names[1] })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, a)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, b, { invite: invite.code })
  await waitForWorld(other)
  return { other, ctx, a, b }
}

/** Whether the server lanes' purse routes are in this build (B and C merge into exp/purse after D starts). */
async function purseServed(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/purse', CONTRACT)
  return res.status() !== 404 && res.status() !== 405
}

// ------------------------------------------------------------ the consent card (client only)

test('the consent card starts empty; All only fills it; Not now sends nothing', async ({ page }) => {
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 1240 }).catch(() => undefined)
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/purse/top-up')) sent.push(r.method())
  })
  await openMenu(page)
  await menu(page).getByTestId('purse-card').scrollIntoViewIfNeeded()
  await shot(page, 'purse-card-desktop')
  const card = await openConsent(page)
  const gold = await habiticaGold(id)
  await expect(card.getByTestId('consent-habitica-gold')).toHaveText(`You have ${gold.toLocaleString('en-US')} gold on Habitica.`)
  await expect(card.getByTestId('consent-amount')).toHaveValue('')
  await expect(card.getByTestId('consent-move')).toBeDisabled()
  await expect(card).toContainText('This spends Habitica gold')
  await expect(card).toContainText('Glimway purse')
  await expect(card).toContainText('Top-ups left today: 2 of 2.')
  // All fills the field and the button follows; nothing is sent.
  await card.getByTestId('consent-amount-all').click()
  await expect(card.getByTestId('consent-amount')).toHaveValue(String(gold))
  await expect(card.getByTestId('consent-move')).toHaveText(`Move ${gold.toLocaleString('en-US')} gold`)
  await expect(card.getByTestId('consent-move')).toBeEnabled()
  // More than Habitica holds, or not a whole number: no.
  await card.getByTestId('consent-amount').fill(String(gold + 1))
  await expect(card.getByTestId('consent-move')).toBeDisabled()
  await card.getByTestId('consent-amount').fill('1.5')
  await expect(card.getByTestId('consent-move')).toBeDisabled()
  await card.getByTestId('consent-amount').fill('5')
  await expect(card.getByTestId('consent-move')).toHaveText('Move 5 gold')
  await shot(page, 'purse-consent-desktop')
  // Not now: closed, nothing sent, and the next card starts empty again.
  await card.getByTestId('consent-not-now').click()
  await expect(card).toBeHidden()
  const again = await openConsent(page)
  await expect(again.getByTestId('consent-amount')).toHaveValue('')
  await again.getByTestId('consent-not-now').click()
  expect(sent).toEqual([])
})

// ------------------------------------------------------------ the top-up (lane B)

test('a top-up moves gold from Habitica into the purse, and the log says so', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Tansy')
  test.skip(!(await purseServed(page)), 'needs lane B’s purse routes')
  await habitica(id, { gp: 1240 })
  const card = await openConsent(page)
  await expect(card.getByTestId('consent-habitica-gold')).toHaveText('You have 1,240 gold on Habitica.')
  await card.getByTestId('consent-amount').fill('200')
  await card.getByTestId('consent-move').click()
  await expect(card.getByTestId('consent-outcome')).toHaveText('200 gold moved into your purse. Habitica: 1,240 → 1,040.', { timeout: 30_000 })
  await expectToast(page, '200 gold moved into your purse.')
  expect(await habiticaGold(id)).toBe(1040)
  expect(purseOf(id)).toBe(200)
  await card.getByTestId('consent-close').click()
  await expect(menu(page).getByTestId('purse-gold')).toHaveText(/200 gold/)
  await expect(menu(page).getByTestId('top-ups-left')).toHaveText('Top-ups left today: 1 of 2.')
  // The token went in that one request: nowhere in the database.
  expect(sql(`SELECT COUNT(*) FROM purse_topups WHERE note LIKE '%${TOKEN}%' OR op_key LIKE '%${TOKEN}%';`)).toBe('0')
  expect((await logLines(page))[0]).toMatch(/Top-up · 200 gold · moved\s*Habitica 1,240 → 1,040\s*\+ 200/)
  // On a desktop the HUD shows it beside the embers.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('hud-gold')).toHaveText('200')
})

test('a top-up for more than Habitica holds now moves nothing and doesn’t use up the day', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Tansy')
  test.skip(!(await purseServed(page)), 'needs lane B’s purse routes')
  await habitica(id, { gp: 1240 })
  const card = await openConsent(page)
  await card.getByTestId('consent-amount').fill('1000')
  // Spent on Habitica meanwhile: the server's own read is the one that counts.
  await habitica(id, { gp: 300 })
  await card.getByTestId('consent-move').click()
  await expect(card.getByTestId('consent-outcome')).toHaveText('Habitica says there isn’t that much gold there now. Nothing moved.', { timeout: 30_000 })
  expect(await habiticaGold(id)).toBe(300)
  expect(purseOf(id)).toBe(0)
  await card.getByTestId('consent-close').click()
  await expect(menu(page).getByTestId('top-ups-left')).toHaveText('Top-ups left today: 2 of 2.')
  expect((await logLines(page))[0]).toMatch(/Top-up · 1,000 gold · not enough/)
})

test('a score that times out is checked, and the gold that left Habitica is credited', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Tansy')
  test.skip(!(await purseServed(page)), 'needs lane B’s purse routes')
  await habitica(id, { gp: 500, score: 'timeout-moved' })
  const card = await openConsent(page)
  await card.getByTestId('consent-amount').fill('120')
  await card.getByTestId('consent-move').click()
  // The answer comes back working; the card says so, calmly, and polls.
  await expect(card.getByTestId('consent-status')).toHaveText(/Checking with Habitica…|Moving gold…/)
  await expect(card.getByTestId('consent-outcome')).toHaveText('Habitica was slow to answer, but your gold there went down by 120, so it’s in your purse.', { timeout: 90_000 })
  expect(purseOf(id)).toBe(120)
  expect(await habiticaGold(id)).toBe(380)
})

// ------------------------------------------------------------ spending gold (lane C)

test('buying flour from Finn with gold', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Ellis')
  const servedHere = await purseServed(page)
  if (servedHere) {
    seedGold(id, 10)
    await rereadState(page)
    await expect.poll(() => shownGold(page)).toBe(10)
  }
  await residentsOut(page, { server: true })
  await warp(page, 'village', 31, 23)
  let offered = false
  for (let i = 0; i < 3 && !offered; i++) {
    await waitForLive(page)
    await openTalk(page, /Talk to Finn/)
    const choices = await untilChoices(page).catch(() => [])
    offered = choices.some((c) => c.text === 'Buy a sack of flour · 2 gold')
    if (offered) {
      // Both prices are offered, each its own choice (the client's part: it runs before the server lanes).
      expect(choices.map((c) => c.text)).toContain('Buy a sack of flour · 1 ember')
      await readDialogue(page, { pick: servedHere ? /Buy a sack of flour · 2 gold/ : /Not yet/ })
    } else await readDialogue(page, { pick: /Not yet|Be on my way|Goodbye/ })
  }
  expect(offered).toBe(true)
  test.skip(!servedHere, 'the buy needs lanes B and C')
  await expect.poll(() => purseOf(id)).toBe(8)
  await expect.poll(() => shownGold(page)).toBe(8)
  expect(sql(`SELECT qty FROM item_stacks WHERE owner = '${accountOf(id)}' AND item_def = 'flour';`)).toBe('1')
  expect((await logLines(page))[0]).toMatch(/Bought flour from Finn\s*− 2/)
})

test('a priced shelf slot: a friend buys it, and both purse logs name the other', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const wren = await freshPlayer(page, 'Wren')
  test.skip(!(await purseServed(page)), 'needs lanes B and C')
  await earnEmbers(page, wren)
  await claimDeed(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  const gate = (await myHome(page, wren)).gate
  fund(wren, { items: { 'comfrey-salve': 1 } })
  const a = accountOf(wren)
  sql(`INSERT INTO homestead_items (id, item_def, location, account_id, homestead_id) VALUES ('shelf-${wren}', 'gate-shelf', 'inventory', '${a}', NULL);
       INSERT INTO ledger (account_id, currency, delta, earned_delta, reason, ref, created_at) VALUES ('${a}', 'decoration:gate-shelf', 1, 0, 'test-grant', 'shelf-${wren}', unixepoch());`)
  await go(page, 'commons', 25, 10)
  const slot = (await homes(page)).slots.find((s) => s.gate === gate)! as HomesView['slots'][number] & { shelf: { tx: number; ty: number } }
  const [sx, sy] = [slot.shelf.tx * 16 + 8, slot.shelf.ty * 16 + 18]
  await place(page, sx, sy)
  await expect(page.locator('.prompt')).toContainText('Set out your gate shelf')
  await page.keyboard.press('e')
  await expect.poll(async () => (await homes(page)).mine?.items.some((i) => i.itemDef === 'gate-shelf' && i.scene === 'gate')).toBe(true)
  await place(page, sx, sy)
  await expect(page.locator('.prompt')).toContainText('Look at the gift shelf')
  await page.keyboard.press('e')
  const shelf = page.getByRole('dialog', { name: /Gift Shelf/ })
  await expect(shelf).toContainText('buy what has a price')
  await shelf.locator('button', { hasText: '+ Put a gift' }).first().click()
  await shelf.getByTestId('stock-price').fill('12')
  await shelf.locator('.stock-btn', { hasText: /Comfrey salve/ }).first().click()
  await expect(shelf.getByTestId('price-slot-0')).toContainText('12 gold')
  await shelf.getByLabel('Close the gift shelf').click()

  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const ivy = await freshPlayer(other, 'Ivy', invite.code)
  seedGold(ivy, 20)
  await rereadState(other)
  await go(other, 'commons', 25, 10)
  await place(other, sx, sy)
  await expect(other.locator('.prompt')).toContainText('Look at the gift shelf')
  await other.keyboard.press('e')
  const theirs = other.getByRole('dialog', { name: /Gift Shelf/ })
  // A priced slot is bought, never taken as a gift.
  await expect(theirs.getByTestId('take-slot-0')).toHaveCount(0)
  await theirs.getByTestId('buy-slot-0').click()
  await expectToast(other, /12 gold/)
  await expect.poll(() => purseOf(ivy)).toBe(8)
  await expect.poll(() => purseOf(wren)).toBe(12)
  expect((await logLines(other))[0]).toMatch(/Bought a comfrey salve from Wren’s shelf\s*− 12/)
  await rereadState(page)
  expect((await logLines(page))[0]).toMatch(/Ivy bought a comfrey salve from your shelf\s*\+ 12/)
  await ctx.close()
})

/** Open your mailbox (you stand at it on your own land). */
async function openMailbox(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status).toBe('ready')
  await atMyMailbox(page)
  await expect(page.locator('.prompt')).toContainText('Check your mailbox')
  await waitForLive(page)
  await page.keyboard.press('e')
  const box = page.getByRole('dialog', { name: 'Mailbox' })
  await expect(box).toBeVisible()
  return box
}

test('a gold letter: sent, collected, both logs right; another recalled and the gold back', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const tansy = await freshPlayer(page, 'Tansy')
  test.skip(!(await purseServed(page)), 'needs lanes B and C')
  await claimDeed(page)
  seedGold(tansy, 50)
  await rereadState(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const bram = await freshPlayer(other, 'Bram', invite.code)
  await claimDeed(other)

  const box = await openMailbox(page)
  await box.getByRole('tab', { name: 'Send something' }).click()
  await box.getByTestId('mail-to').selectOption({ label: 'Bram' })
  await box.getByTestId('mail-gold').click()
  await box.getByTestId('mail-gold-amount').fill('20')
  await expect(box.getByTestId('mail-send')).toHaveText('Send 20 gold')
  await box.getByTestId('mail-send').click()
  await expect(box.locator('.msg.ok')).toContainText('Sent 20 gold to Bram. It waits in their mailbox.')
  await expect.poll(() => purseOf(tansy)).toBe(30)
  // A second, recalled while it waits: the gold comes back.
  await box.getByTestId('mail-gold').click()
  await box.getByTestId('mail-gold-amount-all').click()
  await expect(box.getByTestId('mail-gold-amount')).toHaveValue('30')
  await box.getByTestId('mail-gold-amount').fill('5')
  await box.getByTestId('mail-send').click()
  await expect(box.locator('.msg.ok')).toContainText('Sent 5 gold to Bram')
  await expect.poll(() => purseOf(tansy)).toBe(25)
  await box.getByRole('tab', { name: 'Your mail' }).click()
  await box.locator('[data-sent]', { hasText: '5 gold' }).getByRole('button', { name: 'Recall' }).click()
  await expect(box.locator('.msg.ok')).toContainText('5 gold came back to you')
  await expect.poll(() => purseOf(tansy)).toBe(30)
  await page.keyboard.press('Escape')

  const theirs = await openMailbox(other)
  const letter = theirs.locator('[data-mail]', { hasText: '20 gold' })
  await expect(letter).toContainText('from Tansy')
  await letter.getByRole('button', { name: 'Collect' }).click()
  await expect(theirs.locator('.msg.ok')).toContainText('You collect 20 gold from Tansy')
  await expect.poll(() => purseOf(bram)).toBe(20)
  await other.keyboard.press('Escape')
  expect((await logLines(other))[0]).toMatch(/In a letter from Tansy\s*\+ 20/)
  const mine = await logLines(page)
  expect(mine.some((l) => /Letter to Bram recalled\s*\+ 5/.test(l))).toBe(true)
  expect(mine.some((l) => /Sent to Bram in a letter · collected\s*− 20/.test(l))).toBe(true)
  await ctx.close()
})

test('handing gold to a friend standing near; refused from across the square', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const { other, ctx, a: ash, b: rowan } = await twoPlayers(page, browser, baseURL!, ['Ash', 'Rowan'])
  test.skip(!(await purseServed(page)), 'needs lanes B and C')
  seedGold(ash, 40)
  await rereadState(page)
  await go(page, 'commons', 30, 24)
  await go(other, 'commons', 31, 24)
  const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => { name: string }[] }).__fsRemote?.() ?? []).map((r) => r.name))
  await expect.poll(() => remotes(page), { timeout: 15_000 }).toEqual(['Rowan'])

  const inv = page.getByRole('dialog', { name: 'Inventory' })
  await page.keyboard.press('i')
  const row = inv.getByTestId('purse-row')
  await expect(row).toContainText('40 gold')
  await row.getByRole('button', { name: 'Give…' }).click()
  await row.locator(`[data-give-gold-to="${accountOf(rowan)}"]`).click()
  await row.getByTestId('give-gold-amount').fill('15')
  await row.getByTestId('give-gold').click()
  await expect(inv.getByTestId('inv-message')).toHaveText('You gave Rowan 15 gold.')
  await expectToast(other, 'Ash gave you 15 gold.')
  await expect.poll(() => purseOf(rowan)).toBe(15)
  await expect.poll(() => shownGold(other)).toBe(15)
  expect(purseOf(ash)).toBe(25)

  // Chosen while together, then Rowan walks off across the square: the world refuses.
  await row.getByRole('button', { name: 'Give…' }).click()
  await row.locator(`[data-give-gold-to="${accountOf(rowan)}"]`).click()
  await row.getByTestId('give-gold-amount').fill('5')
  await go(other, 'commons', 8, 30)
  await expect.poll(() => remotes(page), { timeout: 15_000 }).not.toEqual(['Rowan'])
  await row.getByTestId('give-gold').click()
  await expect(inv.getByTestId('inv-message')).toHaveText('Stand next to them to hand it over.')
  expect(purseOf(ash)).toBe(25)
  expect(purseOf(rowan)).toBe(15)
  await ctx.close()
})
