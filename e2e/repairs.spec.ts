import type { Page } from './fixtures'
import { expect, test } from './fixtures'
import { refusal, serverState } from './connected'
import { expectToast, dialogueState, openTalk, readDialogue, untilLine, waitForLive } from './helpers'
import { freshPlayer, fund, giveInstance, go, shot } from './home-helpers'

/**
 * The village's repairs and the returning keepsakes, against this worker's
 * own Go server (docs/items/crafting-and-repair.md "Village repairs",
 * overview "Returning keepsakes"): the well's rotten rope stands visible on
 * the well, the chores list is on the notice board, mending takes the part
 * from the pack (shared per world), Hazel answers, and water can be drawn
 * once the rope is sound. Carrying Tam's halter brings Ada's quiet line,
 * and giving it back is one-time, grants her oil receipts, and thanks only
 * after the world agrees. SCREENS=1 saves screenshots to .agent/screens/.
 */

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

/** The pack (re)read holding `def`: opening the inventory asks the server
 * for the item model, the way a player looks at what they carry. */
async function packHolds(page: Page, def: string): Promise<void> {
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeVisible()
  await expect.poll(() => items(page), { timeout: 15_000 }).not.toBeNull()
  await expect
    .poll(async () => (await items(page))!.stacks.some((s) => s.itemDef === def), { message: `the pack holds ${def}`, timeout: 15_000 })
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeHidden()
}

const dialogue = (page: Page) => page.getByRole('dialog', { name: /Conversation with/ })

async function openBoard(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await go(page, 'village', 15, 10)
  await expect(page.locator('.prompt')).toContainText('Read the notice board')
  await waitForLive(page)
  await page.keyboard.press('e')
  const board = page.getByRole('dialog', { name: 'Notice Board' })
  await expect(board).toBeVisible()
  return board
}

test('the well rope: on the board, on the well, mended with the rope, then water', async ({ page }) => {
  const id = await freshPlayer(page, 'Wren')
  const bucket = giveInstance(id, 'stave-bucket', { max: 90 })
  fund(id, { items: { 'fibre-rope': 1 } })
  await packHolds(page, 'fibre-rope')

  // Drawing water waits for the rope.
  await go(page, 'village', 13, 14)
  await expect(drawWater(page, bucket)).resolves.toEqual({ error: 'well-rope-broken' })

  // The chores list on the notice board points at the well.
  const board = await openBoard(page)
  const chores = board.getByTestId('chores-list')
  await expect(chores).toContainText("The well's rotten rope")
  await expect(chores).toContainText('Fibre rope')
  await shot(page, 'repairs-chores-board')
  await page.keyboard.press('Escape')
  await expect(board).toBeHidden()

  // The broken rope stands on the well, and mending takes the part.
  await go(page, 'village', 13, 14)
  await expect.poll(() => repairs(page), { timeout: 15_000 }).toContain('well-rope')
  // The part is carried: the pack read lands before the mend can take it.
  await expect.poll(() => items(page), { timeout: 15_000 }).not.toBeNull()
  await expect(page.locator('.prompt')).toContainText("Mend the well's rotten rope")
  await waitForLive(page)
  await page.keyboard.press('e')
  await expectToast(page, 'Bread tastes of the well again.')
  await expectToast(page, 'Hazel hands you')
  await expect.poll(() => repairs(page), { timeout: 15_000 }).not.toContain('well-rope')
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'fibre-rope')).toBeUndefined()
  await shot(page, 'repairs-well-mended')

  // The board remembers who mended it, and points at the next chore.
  const board2 = await openBoard(page)
  await expect(board2.getByTestId('chores-list')).toContainText('A fallen fence rail')
  await expect(board2.getByTestId('repairs-history')).toContainText("The well's rotten rope")
  await expect(board2.getByTestId('repairs-history')).toContainText('mended by Wren')
  await page.keyboard.press('Escape')
  await expect(board2).toBeHidden()

  // Water draws again: one draw, one bucket use.
  await go(page, 'village', 13, 14)
  await expect(drawWater(page, bucket)).resolves.toMatchObject({ itemDef: 'stave-bucket', condition: 87 })
})

test('returning a keepsake: Ada asks, "not yet" keeps it, giving back is once', async ({ page }) => {
  const id = await freshPlayer(page, 'Ivy')
  fund(id, { items: { 'knotted-halter': 1 } })
  await packHolds(page, 'knotted-halter')

  await go(page, 'village', 34, 9)
  await openTalk(page, /Talk to Ada/)
  await untilLine(page, /Tam knotted every splice/)
  await readDialogue(page, { pick: /Not yet/ })
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')?.qty).toBe(1)

  // Ask again, and give it back: the return lands (the world's word), her
  // thanks ride a fresh conversation, and the story piece is on the save.
  await openTalk(page, /Talk to Ada/)
  await untilLine(page, /Tam knotted every splice/)
  await readDialogue(page, { pick: /Give it back/ })
  await expect
    .poll(async () => {
      const st = await serverState(page)
      const flags = st.body?.state?.flags ?? []
      return [flags.includes('returned:knotted-halter'), flags.includes('paper:adas-oil-receipts')]
    }, { timeout: 15_000 })
    .toEqual([true, true])
  // The thanks are the server's to give: a word more the world adds once
  // the return has landed (read like a person would).
  await expect
    .poll(async () => (await dialogueState(page)).seen.some((x) => /oil receipts|knot holding/.test(x.text)), {
      message: 'Ada’s thanks after the return'
    })
    .toBe(true)
  if ((await dialogueState(page)).open) await readDialogue(page)
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')).toBeUndefined()

  // The line never asks again (the world's word says it is done).
  await go(page, 'village', 34, 9)
  fund(id, { items: { 'knotted-halter': 1 } })
  await packHolds(page, 'knotted-halter')
  await openTalk(page, /Talk to Ada/)
  await readDialogue(page)
  await expect(dialogue(page)).toBeHidden()
  // `said` is the last conversation's whole text.
  expect((await dialogueState(page)).said.join('\n')).not.toMatch(/Tam knotted every splice/)
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')?.qty).toBe(1)
})

test('a refused return never plays the thanks: the world answers first', async ({ page }) => {
  const id = await freshPlayer(page, 'Rowan')
  fund(id, { items: { 'knotted-halter': 1 } })

  // The world refuses this one: the return is answered 409 (the hero has
  // wandered, say), the way a real refusal arrives.
  await page.route('**/api/items/return', async (route) => route.fulfill(await refusal(page, 'too-far-away')))

  fund(id, { items: { 'knotted-halter': 1 } })
  await packHolds(page, 'knotted-halter')
  await go(page, 'village', 34, 9)
  await openTalk(page, /Talk to Ada/)
  await untilLine(page, /Tam knotted every splice/)
  await readDialogue(page, { pick: /Give it back/ })
  await expect(dialogue(page)).toBeHidden()
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'knotted-halter')?.qty).toBe(1)
  await expectToast(page, 'You need to be right there.')
})
