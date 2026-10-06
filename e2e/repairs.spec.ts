import type { Page } from './fixtures'
import { expect, test } from './fixtures'
import { fund, freshPlayer, giveInstance, go, shot } from './home-helpers'

/**
 * The village's repairs and the returning keepsakes, against the real Go
 * server (docs/items/crafting-and-repair.md "Village repairs", overview
 * "Returning keepsakes"): the well's rotten rope stands visible on the well,
 * the chores list is on the notice board, mending takes the part from the
 * pack (shared per world), Hazel answers, and water can be drawn once the
 * rope is sound. Carrying Tam's halter brings Ada's quiet line, and giving
 * it back is one-time and grants her oil receipts. SCREENS=1 saves
 * screenshots to .agent/screens/.
 */
test.use({ server: true })

type ItemsView = { stacks: { itemDef: string; qty: number }[] } | null
const items = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsItems: () => ItemsView }).__fsItems())
const repairs = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsRepairs?: () => string[] }).__fsRepairs?.() ?? [])
const drawWater = (page: Page, instance: string) =>
  page.evaluate(
    (i) =>
      (window as unknown as {
        __fsDevUseTool: (id: string, n?: number, action?: string) => Promise<unknown>
      }).__fsDevUseTool(i, 1, 'draw'),
    instance
  )

const dialogue = (page: Page) => page.getByRole('dialog', { name: /Conversation with/ })

/** Read a conversation to its end, picking the reply named by `pick` when it
 * shows. Resolves to true when the pick was offered and clicked. Only the
 * line being typed is in the dialog at once, so choices are the evidence. */
async function readThrough(page: Page, pick?: RegExp): Promise<boolean> {
  let picked = !pick
  for (let i = 0; i < 40 && (await dialogue(page).isVisible()); i++) {
    const first = page.locator('.choice').first()
    if (!picked && (await first.isVisible().catch(() => false))) {
      const offer = page.locator('.choice', { hasText: pick! })
      if (await offer.isVisible().catch(() => false)) {
        await offer.click()
        picked = true
      } else {
        await first.click()
      }
    } else if (await first.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
    } else {
      await page.keyboard.press('e')
    }
    await page.waitForTimeout(250)
  }
  await expect(dialogue(page)).toBeHidden()
  return picked
}

test('the well rope: on the board, on the well, mended with the rope, then water', async ({ page }) => {
  const id = await freshPlayer(page, 'Wren')
  const bucket = giveInstance(id, 'stave-bucket', { max: 90 })
  fund(id, { items: { 'fibre-rope': 1 } })

  // The chores list on the notice board points at the well.
  await go(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  const board = page.getByRole('dialog', { name: 'Notice Board' })
  await expect(board).toBeVisible()
  const chores = board.getByTestId('chores-list')
  await expect(chores).toContainText("The well's rotten rope")
  await expect(chores).toContainText('Fibre rope')
  await shot(page, 'repairs-chores-board')
  await page.keyboard.press('Escape')
  await expect(board).toBeHidden()

  // Drawing water waits for the rope.
  await go(page, 'village', 13, 14)
  await expect(drawWater(page, bucket)).resolves.toEqual({ error: 'well-rope-broken' })

  // The broken rope stands on the well, and mending takes the part.
  await expect.poll(() => repairs(page), { timeout: 15_000 }).toContain('well-rope')
  await expect(page.locator('.prompt')).toContainText("Mend the well's rotten rope")
  await page.waitForTimeout(300)
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: 'Bread tastes of the well again.' })).toBeVisible()
  await expect(page.locator('.toast', { hasText: 'Hazel hands you' })).toBeVisible()
  await expect.poll(() => repairs(page), { timeout: 15_000 }).not.toContain('well-rope')
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'fibre-rope')).toBeUndefined()
  await shot(page, 'repairs-well-mended')

  // The board remembers who mended it, and points at the next chore.
  await go(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  await expect(board).toBeVisible()
  await expect(board.getByTestId('chores-list')).toContainText('A fallen fence rail')
  await expect(board.getByTestId('repairs-history')).toContainText("The well's rotten rope")
  await expect(board.getByTestId('repairs-history')).toContainText('mended by Wren')
  await page.keyboard.press('Escape')
  await expect(board).toBeHidden()

  // Water draws again: one draw, one bucket use.
  await expect(drawWater(page, bucket)).resolves.toMatchObject({ itemDef: 'stave-bucket', condition: 87 })
})

test('returning a keepsake: Ada asks, "not yet" keeps it, giving back is once', async ({ page }) => {
  const id = await freshPlayer(page, 'Ivy')
  fund(id, { items: { 'knotted-halter': 1 } })

  await go(page, 'village', 34, 9)
  // Carrying is observable: the pack read lands before the ask can ride.
  await expect.poll(() => items(page), { timeout: 15_000 }).not.toBeNull()
  await expect(page.locator('.prompt')).toContainText('Talk to Ada')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  await expect(dialogue(page)).toBeVisible()
  const kept = await readThrough(page, /Not yet/)
  expect(kept).toBe(true)
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')?.qty).toBe(1)

  // Ask again, and give it back: the return lands (the world's word), her
  // thanks ride a fresh conversation, and the story piece is on the save.
  await expect(page.locator('.prompt')).toContainText('Talk to Ada')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  await expect(dialogue(page)).toBeVisible()
  const gave = await readThrough(page, /Give it back/)
  expect(gave).toBe(true)
  await expect
    .poll(async () => {
      const st = await page.request.get('/api/state').then((r) => r.json())
      return [st.state.flags.includes('returned:knotted-halter'), st.state.flags.includes('paper:adas-oil-receipts')]
    }, { timeout: 15_000 })
    .toEqual([true, true])
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')).toBeUndefined()

  // The world's word: the flags, and the line never asks again.
  const state = await page.request.get('/api/state').then((r) => r.json())
  expect(state.state.flags).toContain('returned:knotted-halter')
  expect(state.state.flags).toContain('paper:adas-oil-receipts')
  await go(page, 'village', 34, 9)
  fund(id, { items: { 'knotted-halter': 1 } })
  await expect(page.locator('.prompt')).toContainText('Talk to Ada')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  await expect(dialogue(page)).toBeVisible()
  const askedAgain = await readThrough(page, /Give it back/)
  expect(askedAgain).toBe(false)
})

test('a refused return never plays the thanks: the world answers first', async ({ page }) => {
  const id = await freshPlayer(page, 'Rowan')
  fund(id, { items: { 'knotted-halter': 1 } })

  // The world refuses this one: the return is answered 409 (the hero has
  // wandered, say), the way a real refusal arrives.
  await page.route('**/api/items/return', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'too-far-away' } }) })
  )

  await go(page, 'village', 34, 9)
  await expect(page.locator('.prompt')).toContainText('Talk to Ada')
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  await expect(dialogue(page)).toBeVisible()
  // Giving back closes on the neutral line only; the thanks are the
  // server's to give, and it refused.
  await readThrough(page, /Give it back/)
  await expect(dialogue(page)).toBeHidden()
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')?.qty).toBe(1)
  await expect(page.locator('.toast', { hasText: 'You need to be right there.' })).toBeVisible()
})
