import { expect, test, type Page } from './fixtures'
import { reenter, seedMarks } from './connected'
import { freshPlayer } from './home-helpers'
import { expectStage, expectToast, readDialogue, openTalk, talkThrough, waitForLive, warp } from './helpers'

/**
 * The opening, Three Fingers off Plumb (quests.md 3, indoors.md 5.7), end to
 * end on a fresh account. The fight with the finger-wisp is seeded (its
 * `defeated:` mark), so the spec walks the talks, the journal and the lamp
 * rather than the whole game.
 *
 * Needs A2 (the server takes `quest-step` for every quest, pays see-mara's
 * 5 glims) to pass.
 */
type QuestsHook = { quests: Record<string, string> }
const step = (page: Page, quest: string) => page.evaluate((q) => (window as unknown as { __fsQuests: () => QuestsHook }).__fsQuests().quests[q], quest)
const goal = (page: Page) => page.locator('.objective').first()
const goalHook = (page: Page) => page.evaluate(() => (window as unknown as { __fsGoal: () => { glow: { id: string } | null } }).__fsGoal())

test('the opening: Orrin, the finger, the lean in the journal, Mara’s ledger, the first lamp', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Tansy', undefined, { opening: true })
  await expect(goal(page)).toContainText('See what Orrin’s grumbling about')

  // Orrin, up his ladder: either reply takes the step.
  await warp(page, 'village', 21, 10)
  await openTalk(page, /Talk to Orrin/)
  await readDialogue(page, { pick: /I’ll fetch it/ })
  await expect.poll(() => step(page, 'signpost')).toBe('meet-orrin')
  await expect(goal(page)).toContainText('Find the signpost’s east finger')

  // The finger-wisp, seeded settled, and the hero where it sat (the step is Brackenwood's): the trigger sees the mark.
  await warp(page, 'woodland', 10, 15)
  // The lost finger lies there, and it glows (the owner's playtest): the
  // step's target stands out, and the tracker says the goal is here.
  await expect.poll(async () => (await goalHook(page)).glow?.id ?? null).toBe('finger-wisp')
  await expect(goal(page).getByTestId('goal-here')).toBeVisible()
  seedMarks(id, 'defeated:finger-wisp')
  await reenter(page, 'woodland')
  await expect.poll(() => step(page, 'signpost')).toBe('fetch-finger')
  await expect(goal(page)).toContainText('Take the finger back to Orrin')
  // Done: the glow goes, and the needle points at the way out, not "here".
  await expect.poll(async () => (await goalHook(page)).glow).toBeNull()
  await expect(goal(page).getByTestId('goal-here')).toHaveCount(0)

  await warp(page, 'village', 21, 10)
  await talkThrough(page, /Talk to Orrin/)
  await expect.poll(() => step(page, 'signpost')).toBe('bring-finger')
  // Write the lean down: the book glows, and the journal opens on Quests with the opening on top.
  await expect(goal(page)).toContainText('Write the lean in your journal')
  await expect(page.getByTestId('journal-button')).toHaveClass(/glow/)
  await waitForLive(page)
  await page.keyboard.press('j')
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await expect(journal.getByRole('tab', { name: 'Quests' })).toHaveAttribute('aria-selected', 'true')
  await expect(journal.locator('[data-quest]').first()).toHaveAttribute('data-quest', 'signpost')
  await expect.poll(() => step(page, 'signpost')).toBe('note-lean')
  // The step's note is the newest of the Notes, the wisp's under it; it reads like a paper.
  await expect(journal.locator('[data-note]')).toHaveText([/Three Fingers off Plumb/, /A Wisp on the Finger/])
  await journal.locator('[data-note="note:signpost:note-lean"]').click()
  await expect(journal.getByRole('article', { name: 'Three Fingers off Plumb' })).toContainText('I don’t think it’s the frost.')
  await journal.getByRole('button', { name: /Quests/ }).first().click()
  await expect(journal.locator('[data-note="note:signpost:note-lean"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('journal-button')).not.toHaveClass(/glow/)

  // Read it back.
  await openTalk(page, /Talk to Orrin/)
  await readDialogue(page, { pick: /Three fingers off plumb, east/ })
  await expect.poll(() => step(page, 'signpost')).toBe('set-post')

  // Mara writes it in the ledger: five glims, and her top-up of three more for a hero with none.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expect.poll(() => step(page, 'signpost')).toBe('see-mara')
  await expectToast(page, /\+8 glims/, { timeout: 15_000 })
  await expect(goal(page)).toContainText('Light the first lamp past the gate')

  // The first lamp: lighting it is the step (its `lit:` mark), with its moment.
  await warp(page, 'woodland', 10, 15)
  await talkThrough(page, /Light the lantern/)
  await expect.poll(() => step(page, 'signpost'), { timeout: 15_000 }).toBe('light-first-lamp')
  await expect(page.getByText('The First Lamp').first()).toBeVisible()

  // And the lantern road begins with Mara.
  await expect(goal(page)).toContainText('Hear Mara out about the road')
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectStage(page, 'accepted')
})
