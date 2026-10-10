import { expect, test } from './fixtures'
import { sql, accountOf, CONTRACT } from './connected'
import { waitForLive, expectToast } from './helpers'
import { claimDeed, earnGlims, freshPlayer, fund, homes, myHome, place, readOn, silasSays, go, atMyMailbox, hurt, type HomesView } from './home-helpers'

/**
 * Gate shelf and maker's-mark thank-you mail (exp/gifts):
 * - Homestead owner sets out a gate-shelf by their gate on the Commons lane.
 * - Owner stocks it with gifts (e.g. comfrey salve).
 * - A traveller walks past, looks at the shelf, and takes a gift into pack.
 * - Traveller is refused a second take from the same shelf on the same UTC day.
 * - When a traveller uses an item made by another player (maker offline/not nearby),
 *   the maker receives a quiet thank-you line in their mail.
 */

test('gate shelf: place shelf on Commons lane, stock it, traveller takes gift, daily limit enforced', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)

  // 1. Wren claims a deed and raises homestead to tier 1
  const idWren = await freshPlayer(page, 'Wren')
  await earnGlims(page, idWren)
  await claimDeed(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)
  const homeWren = await myHome(page, idWren)
  const gateWren = homeWren.gate

  // Fund Wren with 2 comfrey salves and grant an unplaced gate-shelf
  fund(idWren, { items: { 'comfrey-salve': 2 }, materials: { timber: 1 } })
  const aWren = accountOf(idWren)
  sql(`INSERT INTO homestead_items (id, item_def, location, account_id, homestead_id)
       VALUES ('shelf-${idWren}', 'gate-shelf', 'inventory', '${aWren}', NULL);
       INSERT INTO ledger (account_id, currency, delta, earned_delta, reason, ref, created_at)
       VALUES ('${aWren}', 'decoration:gate-shelf', 1, 0, 'test-grant', 'shelf-${idWren}', unixepoch());`)

  // Step out to the Commons lane
  await go(page, 'commons', 25, 10)

  // Find Wren's gate slot coordinates from homes view
  const hView = await homes(page)
  const slotWren = hView.slots.find((s) => s.gate === gateWren)! as HomesView['slots'][number] & { shelf: { tx: number; ty: number } }
  const shelfPx = slotWren.shelf.tx * 16 + 8
  const shelfPy = slotWren.shelf.ty * 16 + 18

  // Walk up to Wren's gate shelf position
  await place(page, shelfPx, shelfPy)

  // Prompt should say "Set out your gate shelf"
  await expect(page.locator('.prompt')).toContainText('Set out your gate shelf')
  await page.keyboard.press('e')

  // Verify shelf is now placed at gate
  await expect.poll(async () => {
    const h = await homes(page)
    return h.mine?.items.some((i) => i.itemDef === 'gate-shelf' && i.scene === 'gate')
  }).toBe(true)

  // Walk up to look at the newly placed shelf
  await place(page, shelfPx, shelfPy)
  await expect(page.locator('.prompt')).toContainText('Look at the gift shelf')
  await page.keyboard.press('e')

  // The GateShelfPanel dialog opens
  const shelfModal = page.getByRole('dialog', { name: /Gift Shelf/ })
  await expect(shelfModal).toBeVisible()

  // Stock slot 0
  const stockBtn = shelfModal.locator('button', { hasText: '+ Put a gift' }).first()
  await expect(stockBtn).toBeVisible()
  await stockBtn.click()

  // Select Comfrey salve from available pack items
  const salveOption = shelfModal.locator('.stock-btn', { hasText: /Comfrey salve/ }).first()
  await expect(salveOption).toBeVisible()
  await salveOption.click()

  // Slot 0 is now stocked with comfrey salve
  await expect(shelfModal.locator('.item-info .name', { hasText: /Comfrey salve/ })).toBeVisible()

  // Leave a second gift so the daily limit remains visible after slot 0 is taken.
  const stockNext = shelfModal.locator('button', { hasText: '+ Put a gift' }).first()
  await expect(stockNext).toBeVisible()
  await stockNext.click()
  const salveAgain = shelfModal.locator('.stock-btn', { hasText: /Comfrey salve/ }).first()
  await expect(salveAgain).toBeVisible()
  await salveAgain.click()

  // Materials use their own wire kind and can be stocked too.
  await expect(stockNext).toBeVisible()
  await stockNext.click()
  const timberOption = shelfModal.locator('.stock-btn', { hasText: 'Timber' }).first()
  await expect(timberOption).toBeVisible()
  await timberOption.click()
  await expect(shelfModal.locator('.item-info .name', { hasText: 'Timber' })).toBeVisible()

  // Close the shelf panel
  await shelfModal.getByLabel('Close the gift shelf').click()
  await expect(shelfModal).toBeHidden()

  // 2. Finn arrives as a traveller on the Commons lane in a fresh browser context
  const invite = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  const inviteCode = (await invite.json()).code as string
  const ctxFinn = await browser.newContext({ baseURL })
  const pageFinn = await ctxFinn.newPage()
  const idFinn = await freshPlayer(pageFinn, 'Finn', inviteCode)
  await go(pageFinn, 'commons', 25, 10)
  await expect.poll(async () => {
    const gate = (await homes(pageFinn)).gates.find((g) => g.gate === gateWren) as (HomesView['gates'][number] & { shelf?: boolean }) | undefined
    return gate?.shelf
  }).toBe(true)

  // Walk up to Wren's gate shelf
  await place(pageFinn, shelfPx, shelfPy)
  await expect(pageFinn.locator('.prompt')).toContainText('Look at the gift shelf')
  await pageFinn.keyboard.press('e')

  const shelfModalFinn = pageFinn.getByRole('dialog', { name: /Gift Shelf/ })
  await expect(shelfModalFinn).toBeVisible()
  await expect(shelfModalFinn).toContainText('Wren’s Gift Shelf')

  // Finn takes the comfrey salve
  const takeBtn = shelfModalFinn.getByTestId('take-slot-0')
  await expect(takeBtn).toBeEnabled()
  await takeBtn.click()

  // Finn receives toast line
  await expectToast(pageFinn, /You took a comfrey salve from Wren’s shelf/)

  // Finn's panel updates to show taken today and button disabled
  await expect(shelfModalFinn.locator('.notice')).toContainText(/taken your gift from this shelf today/)
  await expect(shelfModalFinn.getByTestId('take-slot-1')).toBeDisabled()

  // Verify Finn carries the item in database
  const finnInventory = sql(`SELECT item_def, qty FROM item_stacks WHERE owner = '${accountOf(idFinn)}' AND item_def = 'comfrey-salve';`)
  expect(finnInventory).toContain('comfrey-salve|1')

  // Verify shelf slot 0 is now empty in ledger
  const shelfCount = sql(`SELECT COUNT(*) FROM gate_shelf_slots WHERE homestead_id = '${homeWren.id}' AND slot = 0;`)
  expect(shelfCount).toBe('0')
  await ctxFinn.close()

  // Ira takes the stocked material from another slot.
  const inviteIra = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  const ctxIra = await browser.newContext({ baseURL })
  const pageIra = await ctxIra.newPage()
  const idIra = await freshPlayer(pageIra, 'Ira', (await inviteIra.json()).code as string)
  await go(pageIra, 'commons', 25, 10)
  await expect.poll(async () => (await homes(pageIra)).gates.find((g) => g.gate === gateWren)?.shelf).toBe(true)
  await place(pageIra, shelfPx, shelfPy)
  await expect(pageIra.locator('.prompt')).toContainText('Look at the gift shelf')
  await pageIra.keyboard.press('e')
  const iraShelf = pageIra.getByRole('dialog', { name: /Gift Shelf/ })
  await expect(iraShelf).toBeVisible()
  const iraTake = iraShelf.getByTestId('take-slot-2')
  await expect(iraTake).toBeEnabled()
  await iraTake.click()
  await expectToast(pageIra, /You took a timber from Wren’s shelf/)
  expect(sql(`SELECT item_def,qty FROM item_stacks WHERE owner='${accountOf(idIra)}' AND item_def='timber';`)).toContain('timber|1')
  await ctxIra.close()

  // Two travellers read the same remaining slot before either takes it.
  // One succeeds; the other sees the server's slot-empty refusal in the panel.
  const inviteOne = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  const inviteTwo = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  const ctxOne = await browser.newContext({ baseURL })
  const ctxTwo = await browser.newContext({ baseURL })
  const pageOne = await ctxOne.newPage()
  const pageTwo = await ctxTwo.newPage()
  await freshPlayer(pageOne, 'Moss', (await inviteOne.json()).code as string)
  await freshPlayer(pageTwo, 'Reed', (await inviteTwo.json()).code as string)
  for (const traveller of [pageOne, pageTwo]) {
    await go(traveller, 'commons', 25, 10)
    await expect.poll(async () => (await homes(traveller)).gates.find((g) => g.gate === gateWren)?.shelf).toBe(true)
    await place(traveller, shelfPx, shelfPy)
    await expect(traveller.locator('.prompt')).toContainText('Look at the gift shelf')
    await traveller.keyboard.press('e')
    await expect(traveller.getByRole('dialog', { name: /Gift Shelf/ })).toBeVisible()
  }
  // Both panels have read the slot before either takes it: a click on a
  // button that is not there (or is disabled) would wait out the whole test.
  const takes = [pageOne, pageTwo].map((p) => p.getByTestId('take-slot-1'))
  for (const take of takes) await expect(take).toBeEnabled()
  await Promise.all(takes.map((take) => take.click()))
  await expect.poll(async () => {
    const lines = await Promise.all([pageOne, pageTwo].map(async (p) => p.locator('.msg.error').allTextContents()))
    return lines.flat().some((line) => line.includes('That slot is empty.'))
  }).toBe(true)
  await ctxOne.close()
  await ctxTwo.close()

  // Wren can put the now-empty shelf away from its panel.
  await place(page, shelfPx, shelfPy)
  await expect(page.locator('.prompt')).toContainText('Look at the gift shelf')
  await waitForLive(page)
  await page.keyboard.press('e')
  const ownerShelf = page.getByRole('dialog', { name: /Gift Shelf/ })
  await expect(ownerShelf).toBeVisible()
  const takeDown = ownerShelf.getByRole('button', { name: 'Take down shelf' })
  await expect(takeDown).toBeVisible()
  await takeDown.click()
  await expect(ownerShelf).toBeHidden()
  await expect.poll(async () => (await homes(page)).mine?.items.some((i) => i.itemDef === 'gate-shelf' && i.scene === 'gate')).toBe(false)
})

test('maker thank-you mail: when item made by someone else is used, maker receives thank-you mail', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)

  // 1. Wren registers and gets their home
  const idWren = await freshPlayer(page, 'Wren')
  await earnGlims(page, idWren)
  await claimDeed(page)
  await silasSays(page, /Raise a cottage/)
  await readOn(page, /Steady as a route stone/)
  await expect.poll(async () => (await myHome(page)).tier).toBe(1)

  // 2. Finn joins in a separate context and carries a comfrey salve marked as made by Wren
  const invite = await page.request.post('/api/invites', { data: {}, ...CONTRACT })
  const inviteCode = (await invite.json()).code as string
  const ctxFinn = await browser.newContext({ baseURL })
  const pageFinn = await ctxFinn.newPage()
  const idFinn = await freshPlayer(pageFinn, 'Finn', inviteCode)

  // Fund Finn with a marked healing twist made by Wren, then make room to use it.
  fund(idFinn, { items: { 'keepers-twists': 1 }, maker: idWren })
  await hurt(pageFinn, 20)

  // Finn travels to village (far from Wren who is in commons or home)
  await go(pageFinn, 'village', 15, 10)

  // Finn opens inventory and uses the comfrey salve
  const inv = pageFinn.getByRole('dialog', { name: 'Inventory' })
  await pageFinn.keyboard.press('i')
  await expect(inv).toBeVisible()
  await inv.getByRole('tab', { name: /Supplies/ }).click()
  await inv.locator(`[data-cell="item:keepers-twists@${accountOf(idWren)}"]`).click()
  const salveRow = inv.locator(`[data-item="item:keepers-twists@${accountOf(idWren)}"]`)
  await expect(salveRow).toContainText('Made by Wren')
  await salveRow.getByRole('button', { name: 'Use' }).click()
  await expect(inv.getByTestId('inv-message')).toHaveText("You used Keeper's Twists.")
  // Escape closes the card, then the bag.
  await pageFinn.keyboard.press('Escape')
  if (await inv.isVisible()) await pageFinn.keyboard.press('Escape')
  await ctxFinn.close()

  // Verify thank-you mail exists for Wren in database
  const mailRows = sql(`SELECT kind, item_def FROM mail WHERE to_id = '${accountOf(idWren)}' AND kind = 'thanks';`)
  expect(mailRows).toContain('thanks|keepers-twists')

  // Wren checks their mailbox
  await atMyMailbox(page)
  await expect(page.locator('.prompt')).toContainText('Check your mailbox')
  await waitForLive(page)
  await page.keyboard.press('e')
  const mailPanel = page.getByRole('dialog', { name: 'Mailbox' })
  await expect(mailPanel).toBeVisible()

  // The thank-you mail appears in the mailbox
  await expect(mailPanel).toContainText("Finn used Keeper's Twists you made.")
  await mailPanel.locator('button', { hasText: 'Read' }).click()
})
