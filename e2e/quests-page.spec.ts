import { expect, test, type Page } from './fixtures'
import { reenter, seedStory } from './connected'
import { freshPlayer } from './home-helpers'
import { waitForLive } from './helpers'

/**
 * The journal's Quests page and the pin (docs/design/indoors.md 5.4–5.5):
 * the opening is listed for a new account before it has a row; a pinned
 * quest leads the goal line and its needle; the pin is kept per device and
 * shares one slot with the "How do I…?" guides. SCREENS=1 (or always, for
 * the lane's review) saves the page at desktop and phone sizes.
 */
type QuestsHook = { quests: Record<string, string>; pin: string | null; goal: { kind: string; quest?: string; where: unknown } | null }
const quests = (page: Page) => page.evaluate(() => (window as unknown as { __fsQuests: () => QuestsHook }).__fsQuests())

async function openQuests(page: Page) {
  await waitForLive(page)
  await page.keyboard.press('j')
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await expect(journal).toBeVisible()
  await expect(journal.getByRole('tab', { name: 'Quests' })).toHaveAttribute('aria-selected', 'true')
  return journal
}

test('a new account finds the opening on the Quests page, pins it, and the goal line follows', async ({ page }) => {
  await freshPlayer(page, 'Tansy', undefined, { opening: true })
  // With nothing pinned, the goal line follows the road's current quest: the opening.
  await expect(page.locator('.objective').first()).toContainText('See what Orrin’s grumbling about')
  expect((await quests(page)).goal).toMatchObject({ kind: 'quest', quest: 'signpost', where: { area: 'village', npc: 'orrin' } })

  const journal = await openQuests(page)
  const card = journal.locator('[data-quest="signpost"]')
  await expect(journal.locator('[data-shelf="road"]')).toContainText('The Road')
  await expect(card).toContainText('Three Fingers off Plumb')
  await expect(card).toContainText('See what Orrin’s grumbling about')
  // The next step in full; the rest kept back.
  await expect(card.locator('li.now')).toContainText('Someone up a ladder by the signpost')
  await expect(card.locator('li.later')).toHaveCount(1)
  // Nothing else has been come across yet: no village shelf, no crafts.
  await expect(journal.locator('[data-shelf="village"]')).toHaveCount(0)
  await expect(journal.locator('[data-shelf="craft"]')).toHaveCount(0)
  await expect(journal).toContainText('Arrival in Hearthwick')
  await page.screenshot({ path: '.agent/screens/quests-page-desktop.png' })

  await journal.getByTestId('pin-quest-signpost').click()
  await expect(journal.getByTestId('pin-quest-signpost')).toContainText('Unpin')
  await expect(card).toContainText('Pinned')
  expect((await quests(page)).pin).toBe('quest:signpost')
  await page.keyboard.press('Escape')
  await expect(journal).toBeHidden()
  const pinned = page.getByTestId('goal-pinned-quest')
  await expect(pinned).toContainText('See what Orrin’s grumbling about')
  await expect(page.getByTestId('goal-needle')).toBeVisible()
  await page.screenshot({ path: '.agent/screens/quests-pinned-hud-desktop.png' })

  // Kept on this device: a reload comes back pinned.
  await reenter(page)
  await expect(page.getByTestId('goal-pinned-quest')).toContainText('See what Orrin’s grumbling about')

  // The pinned goal opens the Quests page; one slot: pinning a guide unpins the quest.
  await page.getByTestId('goal-pinned-quest').click()
  const again = page.getByRole('dialog', { name: 'Journal' })
  await expect(again.getByRole('tab', { name: 'Quests' })).toHaveAttribute('aria-selected', 'true')
  await again.getByRole('tab', { name: 'How do I…?' }).click()
  const guide = again.locator('[data-guide]').first()
  await guide.locator('.head').click()
  await guide.locator('[data-testid^="pin-"]').click()
  expect((await quests(page)).pin).toMatch(/^guide:/)
  await again.getByRole('tab', { name: 'Quests' }).click()
  await expect(again.getByTestId('pin-quest-signpost')).toContainText('Pin as my goal')
  await again.getByTestId('pin-quest-signpost').click()
  expect((await quests(page)).pin).toBe('quest:signpost')
  await again.getByTestId('pin-quest-signpost').click()
  expect((await quests(page)).pin).toBeNull()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('goal-pinned-quest')).toHaveCount(0)
})

test('past the opening: done quests fold, and village quests list once started', async ({ page }) => {
  // TODO(A2): needs the server to keep every quest's row (0.3 keeps only the lantern road's).
  const id = await freshPlayer(page, 'Tansy', undefined, { opening: true })
  seedStory(id, { quests: { signpost: 'light-first-lamp', 'set-to-rise': 'hear-hazel', 'stuck-hoist': 'look-hoist' } })
  await reenter(page)
  await expect.poll(async () => (await quests(page)).quests['set-to-rise']).toBe('hear-hazel')
  const journal = await openQuests(page)
  await expect(journal.locator('[data-shelf="road"] .doneline[data-quest="signpost"]')).toContainText('(done)')
  const village = journal.locator('[data-shelf="village"]')
  await expect(village.locator('[data-quest="set-to-rise"]')).toContainText('Bring Hazel a sack of flour')
  await expect(village.locator('[data-quest="stuck-hoist"]')).toContainText('Get a lump of tallow from Hazel')
  // The fake Habitica hero is connected, so Your Own Day isn't locked for this account; it isn't come across yet either.
  await expect(village.locator('[data-quest="your-own-day"]')).toHaveCount(0)
  await village.locator('[data-quest="stuck-hoist"] .head').click()
  await expect(village.locator('[data-quest="stuck-hoist"] li.done')).toHaveCount(2)
  await page.screenshot({ path: '.agent/screens/quests-page-village-desktop.png' })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })

  test('the Quests page fits a phone, and pins from it', async ({ page }) => {
    await freshPlayer(page, 'Tansy', undefined, { opening: true })
    await waitForLive(page)
    await page.getByRole('button', { name: /^Journal/ }).tap()
    const journal = page.getByRole('dialog', { name: 'Journal' })
    await expect(journal.getByRole('tab', { name: 'Quests' })).toHaveAttribute('aria-selected', 'true')
    // Nothing scrolls sideways.
    const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.panel')].filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth))
    for (const o of overflow) expect(o).toBeLessThanOrEqual(1)
    const pin = journal.getByTestId('pin-quest-signpost')
    await pin.scrollIntoViewIfNeeded()
    const b = (await pin.boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: '.agent/screens/quests-page-phone.png' })
    await pin.tap()
    await expect(pin).toContainText('Unpin')
    await journal.getByRole('button', { name: 'Close journal' }).tap()
    await expect(page.getByTestId('goal-pinned-quest')).toContainText('See what Orrin’s grumbling about')
    await page.screenshot({ path: '.agent/screens/quests-pinned-hud-phone.png' })
  })
})
