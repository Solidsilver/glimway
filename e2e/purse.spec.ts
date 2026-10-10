import type { Browser, BrowserContext } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, allow, CONTRACT, habiticaURL, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, sql, TOKEN, waitForWorld } from './connected'
import { expectToast, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'
import { residentsOut } from './room-helpers'
import { atMyMailbox, claimDeed, earnGlims, freshPlayer, fund, go, homes, myHome, place, readOn, shot, silasSays, type HomesView } from './home-helpers'

/**
 * Glims' top-up and the Glim log in the game (docs/design/silas-yard.md 1.5,
 * 1.6; the 0.6 purse, purse-and-wardrobe.md 2, 3, 10.2, with gold read as
 * glims): "Turn Habitica gold into glims" against the fake Habitica (moved,
 * not enough, a score that times out and a check that confirms it, the day's
 * cap), buying flour from Finn at its one price, a priced shelf slot a friend
 * buys, a glim letter sent, collected and recalled, and glims handed over in
 * the square.
 *
 * The 2:1 credit, the 30-glim cap and `Purse.glims_left` are lane G-B's
 * (the server); the consent card's Max and its "Today you can still get N
 * glims" line read `glimsLeft`, so they wait for it too. Glims for spending
 * are put in directly (`seedGlims`), as the dev tools do, so those tests
 * don't depend on a top-up.
 */

/**
 * The fake Habitica's gold and its score switch (e2e/server/fake-habitica.ts):
 * `gp` is the hero's Habitica gold; `score: 'timeout-moved'` makes the score
 * take the gold and then not answer in time, so the worker's balance check
 * has to confirm it.
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

/** Glims without a top-up or a sync (both sides of the ledger, never XP-earned). */
function seedGlims(id: string, glims: number): void {
  const a = accountOf(id)
  sql(`UPDATE balances SET glims = glims + ${glims} WHERE account_id = '${a}';
       INSERT INTO ledger (account_id, currency, delta, earned_delta, reason, ref, created_at)
       VALUES ('${a}', 'glims', ${glims}, 0, 'test-grant', 'e2e', unixepoch());
       UPDATE players SET version = version + 1 WHERE account_id = '${a}';`)
}

/** Glims as the server keeps them. */
function glimsOf(id: string): number {
  return Number(sql(`SELECT glims FROM balances WHERE account_id = '${accountOf(id)}';`))
}

/** How many of them were earned from Habitica XP. */
function xpGlimsOf(id: string): number {
  return Number(sql(`SELECT xp_glims FROM balances WHERE account_id = '${accountOf(id)}';`))
}

/** The HUD's one counter. */
const hudGlims = (page: Page) => page.getByTestId('hud-glims')

/** Read the state again (seeded glims show after a state read). */
async function rereadState(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fsPurse: { reread: () => Promise<void> } }).__fsPurse.reread())
}

const menu = (page: Page) => page.getByRole('dialog', { name: 'Menu' })

/** Escape until the Menu is up: a panel still open (a shelf, a mailbox) takes the first one. */
async function openMenu(page: Page): Promise<void> {
  await expect(async () => {
    if (!(await menu(page).isVisible())) await page.keyboard.press('Escape')
    await expect(menu(page)).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await expect(menu(page).getByTestId('purse-card')).toBeVisible()
}

/** Menu → Turn gold into glims (it syncs first) → the consent card. */
async function openConsent(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await openMenu(page)
  await menu(page).getByTestId('purse-top-up').click()
  const card = page.getByRole('dialog', { name: 'Turn Habitica gold into glims' })
  await expect(card).toBeVisible()
  return card
}

/** The Glim log's lines, as the sheet shows them. */
async function logLines(page: Page): Promise<string[]> {
  await openMenu(page)
  await menu(page).getByTestId('purse-log-open').click()
  const sheet = page.getByRole('dialog', { name: 'Glim log' })
  await expect(sheet.getByTestId('purse-log')).toBeVisible()
  const lines = await sheet.locator('.entry').allInnerTexts()
  await sheet.getByLabel('Close the glim log').click()
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


// ------------------------------------------------------------ the consent card

test('the consent card picks glims and shows the gold; Max only fills the field; Not now sends nothing', async ({ page }) => {
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 1240 })
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/purse/top-up')) sent.push(r.method())
  })
  await openMenu(page)
  const block = menu(page).getByTestId('purse-card')
  await block.scrollIntoViewIfNeeded()
  await expect(block).toContainText('Glims come from the XP you earn on Habitica.')
  await expect(block.getByTestId('purse-top-up')).toHaveText('Turn gold into glims')
  await expect(block.getByTestId('purse-log-open')).toContainText('Glim log')
  // G-B: Purse.glims_left (30 on a fresh day).
  await expect(block.getByTestId('top-ups-left')).toHaveText('Today you can still get 30 glims, in up to 2 top-ups.')
  await shot(page, 'purse-card-desktop')
  const card = await openConsent(page)
  await expect(card.getByTestId('consent-habitica-gold')).toHaveText('You have 1,240 gold on Habitica.')
  await expect(card.getByTestId('consent-amount')).toHaveValue('')
  await expect(card.getByTestId('consent-get')).toBeDisabled()
  await expect(card.getByTestId('consent-rate')).toHaveText('Two gold for each glim.')
  await expect(card.getByTestId('consent-left')).toHaveText('Today you can still get 30 glims, in up to 2 top-ups.')
  await expect(card).toContainText('This spends Habitica gold')
  await expect(card).toContainText('Glims can’t be turned back into gold.')
  await expect(card).toContainText('Glimway purse')
  // Max: min(floor(1240 / 2), 30 left today) = 30. It fills the field and the button follows; nothing is sent.
  await card.getByTestId('consent-amount-max').click()
  await expect(card.getByTestId('consent-amount')).toHaveValue('30')
  await expect(card.getByTestId('consent-get')).toHaveText('Get 30 glims')
  await expect(card.getByTestId('consent-rate')).toHaveText('Two gold for each glim: 30 glims costs 60 gold.')
  await expect(card.getByTestId('consent-get')).toBeEnabled()
  // More than Max, or not a whole number: no.
  await card.getByTestId('consent-amount').fill('31')
  await expect(card.getByTestId('consent-get')).toBeDisabled()
  await card.getByTestId('consent-amount').fill('1.5')
  await expect(card.getByTestId('consent-get')).toBeDisabled()
  await card.getByTestId('consent-amount').fill('20')
  await expect(card.getByTestId('consent-get')).toHaveText('Get 20 glims')
  await expect(card.getByTestId('consent-rate')).toHaveText('Two gold for each glim: 20 glims costs 40 gold.')
  await shot(page, 'purse-consent-desktop')
  // Not now: closed, nothing sent, and the next card starts empty again.
  await card.getByTestId('consent-not-now').click()
  await expect(card).toBeHidden()
  // Little gold: Max is what it pays for (41 gold → 20 glims).
  await habitica(id, { gp: 41 })
  const again = await openConsent(page)
  await expect(again.getByTestId('consent-amount')).toHaveValue('')
  await again.getByTestId('consent-amount-max').click()
  await expect(again.getByTestId('consent-amount')).toHaveValue('20')
  await again.getByTestId('consent-not-now').click()
  // Under two gold there's nothing to get.
  await habitica(id, { gp: 1 })
  const none = await openConsent(page)
  await expect(none).toContainText('You need at least 2 gold on Habitica for a glim.')
  await expect(none.getByTestId('consent-get')).toBeDisabled()
  await none.getByTestId('consent-not-now').click()
  expect(sent).toEqual([])
})

// ------------------------------------------------------------ the top-up (the server is lane G-B's)

test('a top-up turns gold into glims, two for one, and the log and the HUD say so', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 1240 })
  const card = await openConsent(page)
  await expect(card.getByTestId('consent-habitica-gold')).toHaveText('You have 1,240 gold on Habitica.')
  // Read after the card's sync: it is what credits Mara's welcome glims.
  const before = glimsOf(id)
  const earned = xpGlimsOf(id)
  await card.getByTestId('consent-amount').fill('20')
  const request = page.waitForRequest((r) => r.url().includes('/api/purse/top-up'))
  await card.getByTestId('consent-get').click()
  // The request asks for the gold: two for each glim.
  expect((await request).postDataJSON().amount).toBe(40)
  // G-B: the 2:1 credit.
  await expect(card.getByTestId('consent-outcome')).toHaveText('20 glims caught the light. Habitica: 1,240 → 1,200 gold.', { timeout: 30_000 })
  await expectToast(page, '20 glims caught the light.')
  expect(await habiticaGold(id)).toBe(1200)
  expect(glimsOf(id)).toBe(before + 20)
  // Glims from a top-up are never XP-earned (silas-yard.md 1.4 rule 4).
  expect(xpGlimsOf(id)).toBe(earned)
  await card.getByTestId('consent-close').click()
  await expect(menu(page).getByTestId('top-ups-left')).toHaveText('Today you can still get 10 glims, in up to one top-up.')
  // The token went in that one request: nowhere in the database.
  expect(sql(`SELECT COUNT(*) FROM purse_topups WHERE note LIKE '%${TOKEN}%' OR op_key LIKE '%${TOKEN}%';`)).toBe('0')
  expect(sql(`SELECT amount || ':' || glims FROM purse_topups WHERE account_id = '${accountOf(id)}';`)).toBe('40:20')
  expect((await logLines(page))[0]).toMatch(/Top-up · 20 glims · moved\s*Habitica 1,240 → 1,200 gold\s*\+ 20/)
  // One counter on the HUD, glims; no gold beside it.
  await page.keyboard.press('Escape')
  await expect(hudGlims(page)).toHaveText(String(before + 20))
  await expect(page.getByTestId('hud-gold')).toHaveCount(0)
})

test('the day’s cap: Max stops at what’s left, and the world refuses past 30 glims in plain words', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 1240 })
  const card = await openConsent(page)
  await card.getByTestId('consent-amount-max').click()
  await expect(card.getByTestId('consent-amount')).toHaveValue('30')
  await card.getByTestId('consent-amount').fill('25')
  // Another tab gets 10 glims meanwhile: today's top-ups now hold 10.
  sql(`INSERT INTO purse_topups (id, account_id, op_key, amount, glims, state, gold_before, gold_after, created_at, settled_at, settled_by)
       VALUES ('tu-other-${id}', '${accountOf(id)}', 'other-tab', 20, 10, 'moved', 1260, 1240, unixepoch(), unixepoch(), 'worker');`)
  await card.getByTestId('consent-get').click()
  // G-B: `top-up-cap` (silas-yard.md 1.5).
  await expect(card.getByTestId('consent-error')).toHaveText('That’s more glims than top-ups can bring today. Max shows what’s left; more after midnight UTC.')
  expect(await habiticaGold(id)).toBe(1240)
  await card.getByTestId('consent-not-now').click()
  // A fresh look: Max is what's left of the day.
  const again = await openConsent(page)
  await expect(again.getByTestId('consent-left')).toHaveText('Today you can still get 20 glims, in up to one top-up.')
  await again.getByTestId('consent-amount-max').click()
  await expect(again.getByTestId('consent-amount')).toHaveValue('20')
  await again.getByTestId('consent-not-now').click()
})

test('a top-up for more than Habitica holds now moves nothing and doesn’t use up the day', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 1240 })
  const card = await openConsent(page)
  // Read after the card's sync: it is what credits Mara's welcome glims.
  const before = glimsOf(id)
  await card.getByTestId('consent-amount').fill('25')
  // Spent on Habitica meanwhile: the server's own read is the one that counts.
  await habitica(id, { gp: 30 })
  await card.getByTestId('consent-get').click()
  await expect(card.getByTestId('consent-outcome')).toHaveText('Habitica says there isn’t that much gold there now. Nothing moved.', { timeout: 30_000 })
  expect(await habiticaGold(id)).toBe(30)
  expect(glimsOf(id)).toBe(before)
  await card.getByTestId('consent-close').click()
  await expect(menu(page).getByTestId('top-ups-left')).toHaveText('Today you can still get 30 glims, in up to 2 top-ups.')
  expect((await logLines(page))[0]).toMatch(/Top-up · 25 glims · not enough/)
})

test('a score that times out is checked, and the gold that left Habitica becomes glims', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Tansy')
  await habitica(id, { gp: 500, score: 'timeout-moved' })
  const card = await openConsent(page)
  // Read after the card's sync: it is what credits Mara's welcome glims.
  await expect(card.getByTestId('consent-habitica-gold')).toHaveText('You have 500 gold on Habitica.')
  const before = glimsOf(id)
  await card.getByTestId('consent-amount').fill('12')
  await card.getByTestId('consent-get').click()
  // The answer comes back working; the card says so, calmly, and polls.
  await expect(card.getByTestId('consent-status')).toHaveText(/Checking with Habitica…|Turning gold into glims…/)
  await expect(card.getByTestId('consent-outcome')).toHaveText('Habitica was slow to answer, but your gold there went down by 24, so 12 glims caught the light.', { timeout: 90_000 })
  expect(glimsOf(id)).toBe(before + 12)
  expect(await habiticaGold(id)).toBe(476)
})

// ------------------------------------------------------------ spending glims

test('buying flour from Finn at its one price in glims', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Ellis')
  seedGlims(id, 10)
  await rereadState(page)
  const before = glimsOf(id)
  await expect(hudGlims(page)).toHaveText(String(before))
  await residentsOut(page, { server: true })
  await warp(page, 'village', 31, 23)
  let offered = false
  for (let i = 0; i < 3 && !offered; i++) {
    await waitForLive(page)
    await openTalk(page, /Talk to Finn/)
    const choices = await untilChoices(page).catch(() => [])
    offered = choices.some((c) => c.text === 'Buy a sack of flour · 1 glim')
    if (offered) {
      // One price, one choice (silas-yard.md 1.6).
      expect(choices.filter((c) => /flour/.test(c.text))).toHaveLength(1)
      await readDialogue(page, { pick: /Buy a sack of flour · 1 glim/ })
    } else await readDialogue(page, { pick: /Not yet|Be on my way|Goodbye/ })
  }
  expect(offered).toBe(true)
  await expect.poll(() => glimsOf(id)).toBe(before - 1)
  await expect(hudGlims(page)).toHaveText(String(before - 1))
  expect(sql(`SELECT qty FROM item_stacks WHERE owner = '${accountOf(id)}' AND item_def = 'flour';`)).toBe('1')
  // G-B: which rows the Glim log shows (a market buy is one).
  expect((await logLines(page))[0]).toMatch(/Bought flour from Finn\s*− 1/)
})

test('a priced shelf slot: a friend buys it in glims, and both logs name the other', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const wren = await freshPlayer(page, 'Wren')
  await earnGlims(page, wren)
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
  await expect(shelf).toContainText('Price in glims')
  await shelf.getByTestId('stock-price').fill('12')
  await shelf.locator('.stock-btn', { hasText: /Comfrey salve/ }).first().click()
  await expect(shelf.getByTestId('price-slot-0')).toContainText('12 glims')
  await shelf.getByLabel('Close the gift shelf').click()
  const wrenBefore = glimsOf(wren)

  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const ivy = await freshPlayer(other, 'Ivy', invite.code)
  seedGlims(ivy, 20)
  await rereadState(other)
  const ivyBefore = glimsOf(ivy)
  await go(other, 'commons', 25, 10)
  await place(other, sx, sy)
  await expect(other.locator('.prompt')).toContainText('Look at the gift shelf')
  await other.keyboard.press('e')
  const theirs = other.getByRole('dialog', { name: /Gift Shelf/ })
  // A priced slot is bought, never taken as a gift.
  await expect(theirs.getByTestId('take-slot-0')).toHaveCount(0)
  await expect(theirs.getByTestId('buy-slot-0')).toHaveText('Buy · 12 glims')
  await theirs.getByTestId('buy-slot-0').click()
  await expectToast(other, /12 glims/)
  await expect.poll(() => glimsOf(ivy)).toBe(ivyBefore - 12)
  await expect.poll(() => glimsOf(wren)).toBe(wrenBefore + 12)
  // The shelf stays open after a buy (as after a Take): close it before the Menu.
  await theirs.getByLabel('Close the gift shelf').click()
  await expect(theirs).toHaveCount(0)
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

test('a glim letter: sent, collected, both logs right; another recalled and the glims back', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  const tansy = await freshPlayer(page, 'Tansy')
  await claimDeed(page)
  seedGlims(tansy, 50)
  await rereadState(page)
  const start = glimsOf(tansy)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx = await browser.newContext({ baseURL })
  const other = await ctx.newPage()
  const bram = await freshPlayer(other, 'Bram', invite.code)
  await claimDeed(other)
  const bramStart = glimsOf(bram)

  const box = await openMailbox(page)
  await box.getByRole('tab', { name: 'Send something' }).click()
  await box.getByTestId('mail-to').selectOption({ label: 'Bram' })
  await box.getByTestId('mail-glims').click()
  await box.getByTestId('mail-glims-amount').fill('20')
  await expect(box.getByTestId('mail-send')).toHaveText('Send 20 glims')
  await box.getByTestId('mail-send').click()
  await expect(box.locator('.msg.ok')).toContainText('Sent 20 glims to Bram. They wait in their mailbox.')
  await expect.poll(() => glimsOf(tansy)).toBe(start - 20)
  // A second, recalled while it waits: the glims come back. Max fills what's left.
  await box.getByTestId('mail-glims').click()
  await box.getByTestId('mail-glims-amount-max').click()
  await expect(box.getByTestId('mail-glims-amount')).toHaveValue(String(start - 20))
  await box.getByTestId('mail-glims-amount').fill('5')
  await box.getByTestId('mail-send').click()
  await expect(box.locator('.msg.ok')).toContainText('Sent 5 glims to Bram')
  await expect.poll(() => glimsOf(tansy)).toBe(start - 25)
  await box.getByRole('tab', { name: 'Your mail' }).click()
  await box.locator('[data-sent]', { hasText: '5 glims' }).getByRole('button', { name: 'Recall' }).click()
  await expect(box.locator('.msg.ok')).toContainText('5 glims came back to you')
  await expect.poll(() => glimsOf(tansy)).toBe(start - 20)
  await page.keyboard.press('Escape')

  const theirs = await openMailbox(other)
  const letter = theirs.locator('[data-mail]', { hasText: '20 glims' })
  await expect(letter).toContainText('from Tansy')
  await letter.getByRole('button', { name: 'Collect' }).click()
  await expect(theirs.locator('.msg.ok')).toContainText('You collect 20 glims from Tansy')
  await expect.poll(() => glimsOf(bram)).toBe(bramStart + 20)
  await other.keyboard.press('Escape')
  expect((await logLines(other))[0]).toMatch(/In a letter from Tansy\s*\+ 20/)
  const mine = await logLines(page)
  expect(mine.some((l) => /Letter to Bram recalled\s*\+ 5/.test(l))).toBe(true)
  expect(mine.some((l) => /Sent to Bram in a letter · collected\s*− 20/.test(l))).toBe(true)
  await ctx.close()
})

test('handing glims to a friend standing near; refused from across the square', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const { other, ctx, a: ash, b: rowan } = await twoPlayers(page, browser, baseURL!, ['Ash', 'Rowan'])
  seedGlims(ash, 40)
  await rereadState(page)
  const ashStart = glimsOf(ash)
  const rowanStart = glimsOf(rowan)
  await go(page, 'commons', 30, 24)
  await go(other, 'commons', 31, 24)
  const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => { name: string }[] }).__fsRemote?.() ?? []).map((r) => r.name))
  await expect.poll(() => remotes(page), { timeout: 15_000 }).toEqual(['Rowan'])

  const inv = page.getByRole('dialog', { name: 'Inventory' })
  await page.keyboard.press('i')
  const row = inv.getByTestId('glims-row')
  await expect(row).toContainText(`${ashStart} glims`)
  await row.getByRole('button', { name: 'Give…' }).click()
  await row.locator(`[data-give-glims-to="${accountOf(rowan)}"]`).click()
  await row.getByTestId('give-glims-amount').fill('15')
  await row.getByTestId('give-glims').click()
  await expect(inv.getByTestId('inv-message')).toHaveText('You gave Rowan 15 glims.')
  await expectToast(other, 'Ash gave you 15 glims.')
  await expect.poll(() => glimsOf(rowan)).toBe(rowanStart + 15)
  await expect(hudGlims(other)).toHaveText(String(rowanStart + 15))
  expect(glimsOf(ash)).toBe(ashStart - 15)

  // Chosen while together, then Rowan walks off across the square: the world refuses.
  await row.getByRole('button', { name: 'Give…' }).click()
  await row.locator(`[data-give-glims-to="${accountOf(rowan)}"]`).click()
  await row.getByTestId('give-glims-amount').fill('5')
  await go(other, 'commons', 8, 30)
  // Still in the Commons (so still on Ash's screen), but past the give
  // radius (content/items.json: 3 tiles) from Ash at (30, 24).
  const tilesFromAsh = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => { name: string; x: number; y: number }[] }).__fsRemote?.() ?? []).filter((r) => r.name === 'Rowan').map((r) => Math.hypot(r.x - (30 * 16 + 8), r.y - (24 * 16 + 8)) / 16))
  await expect.poll(async () => (await tilesFromAsh(page))[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(3)
  await row.getByTestId('give-glims').click()
  await expect(inv.getByTestId('inv-message')).toHaveText('Stand next to them to hand it over.')
  expect(glimsOf(ash)).toBe(ashStart - 15)
  expect(glimsOf(rowan)).toBe(rowanStart + 15)
  await ctx.close()
})
