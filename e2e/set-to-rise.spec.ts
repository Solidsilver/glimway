import { expect, test, type Page } from './fixtures'
import { moveServerClock, serverState } from './connected'
import { freshPlayer, fund } from './home-helpers'
import { dialogueState, expectToast, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'

/**
 * Set to Rise across a wait (indoors.md 5.6): Hazel's `with` gate on her
 * cycle, the flour taken by the `item` gate, and two hours on the dev clock
 * for the `wait`. Hazel is met out in the square (minutes 40–60 of her hour),
 * so this spec doesn't need the kitchen.
 *
 * Needs A2 (the gates on `quest-step`, `gate_at` in the state) to pass.
 */
type QuestsHook = { quests: Record<string, string>; gateAt: Record<string, number> }
const quests = (page: Page) => page.evaluate(() => (window as unknown as { __fsQuests: () => QuestsHook }).__fsQuests())
const stack = (page: Page, def: string) =>
  page.evaluate((d) => (window as unknown as { __fsItems: (() => { stacks: { itemDef: string; qty: number }[] } | null) & { load: () => Promise<unknown> } }).__fsItems()?.stacks.find((s) => s.itemDef === d)?.qty ?? 0, def)
const reloadPack = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())

/** Move both clocks (the world's and this page's) to `unix`. */
async function clockTo(page: Page, unix: number): Promise<void> {
  await moveServerClock(page, unix)
  await page.evaluate((n) => (window as unknown as { __fsDevCalendar: (n: number) => void }).__fsDevCalendar(n), unix)
}

/** :45 past the next hour after `t`: Hazel is out in the square. */
const squareTime = (t: number) => (Math.floor(t / 3600) + 1) * 3600 + 45 * 60

test('Set to Rise: Hazel asks, the flour goes in, and the sponge rises two hours later', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Bryn')
  const start = squareTime(Math.floor(Date.now() / 1000))
  await clockTo(page, start)
  await warp(page, 'village', 13, 15)

  // The first talk is her introduction (with the hint); the next one asks.
  await openTalk(page, /Talk to Hazel/)
  await readDialogue(page)
  expect((await dialogueState(page)).said.join(' ')).toContain('a sponge that wants feeding')
  await waitForLive(page)
  await openTalk(page, /Talk to Hazel/)
  await readDialogue(page, { pick: /fetch you some flour/ })
  await expect.poll(async () => (await quests(page)).quests['set-to-rise']).toBe('hear-hazel')

  // Flour in the pack takes the next step by itself.
  fund(id, { items: { flour: 1 } })
  await reloadPack(page)
  await expect.poll(() => stack(page, 'flour')).toBe(1)
  await expect.poll(async () => (await quests(page)).quests['set-to-rise'], { timeout: 10_000 }).toBe('fetch-flour')

  // Set the sponge: the gate takes the flour.
  await waitForLive(page)
  await openTalk(page, /Talk to Hazel/)
  await untilChoices(page)
  await expect(page.locator('.choice', { hasText: 'Set the sponge' })).toContainText('1 flour')
  await readDialogue(page, { pick: /Set the sponge/ })
  await expect.poll(async () => (await quests(page)).quests['set-to-rise'], { timeout: 15_000 }).toBe('set-sponge')
  await reloadPack(page)
  await expect.poll(() => stack(page, 'flour')).toBe(0)
  const setAt = (await quests(page)).gateAt['set-to-rise']
  expect(setAt).toBeGreaterThan(0)

  // Too soon: her "not yet", with the wait in her words, and no step.
  await waitForLive(page)
  await openTalk(page, /Talk to Hazel/)
  await readDialogue(page)
  expect((await dialogueState(page)).said.join(' ')).toMatch(/Not yet.*Give it about 2 h/)
  expect((await quests(page)).quests['set-to-rise']).toBe('set-sponge')

  // Two hours on (back in the square, a few minutes after the sponge was set), it has risen.
  const embers = (await serverState(page)).body.state.embers as number
  await clockTo(page, start + 2 * 3600 + 5 * 60)
  await waitForLive(page)
  await openTalk(page, /Talk to Hazel/)
  await readDialogue(page, { pick: /Lift the cloth/ })
  await expect.poll(async () => (await quests(page)).quests['set-to-rise'], { timeout: 15_000 }).toBe('let-it-rise')
  await expectToast(page, /\+2 embers/, { timeout: 15_000 })
  await expect.poll(async () => (await serverState(page)).body.state.embers).toBe(embers + 2)
  await reloadPack(page)
  await expect.poll(() => stack(page, 'keepers-twists')).toBe(2)

  // Her note in the journal.
  await page.keyboard.press('j')
  await expect(page.getByRole('dialog', { name: 'Journal' }).locator('[data-note]').first()).toHaveText(/Set to Rise/)
})
