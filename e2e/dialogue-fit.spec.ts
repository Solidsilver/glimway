import { expect, test, type Page } from './fixtures'
import { dialogueState, waitForLive } from './helpers'
import { freshPlayer } from './home-helpers'
import { CAMP_RULE_WORDS } from '../src/content/camps'

/**
 * A long conversation stays on the screen (step-back 2 2026-10-18, C2): a
 * keeper's rules with the most members a list holds (64,
 * server/internal/api/claim_rules.go) keep their heading and their way out in
 * view, and the replies between scroll, on a short landscape phone and on a
 * desktop.
 */

const MEMBERS = 64

/** The keeper's rules as camps.ts builds them, with a full list of names. */
async function openLongList(page: Page): Promise<void> {
  const choices = [
    ...Object.values(CAMP_RULE_WORDS.rules).map((r) => ({ text: r.pick, action: 'none' })),
    { text: CAMP_RULE_WORDS.name, action: 'none', disabled: true, note: CAMP_RULE_WORDS.noneToName },
    ...Array.from({ length: MEMBERS }, (_, i) => ({ text: CAMP_RULE_WORDS.unname(`Traveller ${i + 1}`), action: 'none' })),
    { text: CAMP_RULE_WORDS.done, dismiss: true }
  ]
  await waitForLive(page)
  await page.evaluate((choices) => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('ui:dialogue', { id: 'camp-rules', speaker: CAMP_RULE_WORDS.heading, lines: ['Who may build at this lamp.'], choices }), choices)
  await expect.poll(async () => (await dialogueState(page)).choices?.length ?? 0, { message: 'the replies are shown' }).toBe(choices.length)
}

async function checkFits(page: Page, height: number): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  const box = (await dialogue.locator('.box').boundingBox())!
  expect(box.y, 'the box starts on the screen').toBeGreaterThanOrEqual(0)
  expect(box.y + box.height, 'and ends on it').toBeLessThanOrEqual(height)
  // The heading and the way out are in view; the list between scrolls.
  await expect(dialogue.locator('.tag')).toBeInViewport()
  const done = dialogue.getByRole('button', { name: CAMP_RULE_WORDS.done })
  await expect(done).toBeInViewport()
  const first = dialogue.getByRole('button', { name: CAMP_RULE_WORDS.rules.household.pick })
  await expect(first).toBeInViewport()
  const last = dialogue.getByRole('button', { name: CAMP_RULE_WORDS.unname(`Traveller ${MEMBERS}`) })
  await expect(last).not.toBeInViewport()
  const body = dialogue.locator('.body')
  await body.hover()
  await page.mouse.wheel(0, 20_000)
  await expect(last, 'the last name scrolls into view').toBeInViewport()
  await expect(dialogue.locator('.tag')).toBeInViewport()
  await expect(done).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath(`dialogue-long-list-${height}.png`) })
  await done.click()
  await expect(dialogue).toBeHidden()
}

test.describe('short landscape phone', () => {
  test.use({ hasTouch: true })

  test('a keeper’s 64 names scroll between the heading and Done at 320 px high', async ({ page }) => {
    await freshPlayer(page)
    await page.setViewportSize({ width: 568, height: 320 })
    await openLongList(page)
    await checkFits(page, 320)
  })
})

test('a keeper’s 64 names scroll between the heading and Done on a desktop', async ({ page }) => {
  await freshPlayer(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await openLongList(page)
  await checkFits(page, 720)
})
