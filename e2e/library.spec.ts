import { expect, test, type Page } from './fixtures'
import { reenter, seedMarks } from './connected'
import { freshPlayer } from './home-helpers'
import { dialogueState, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'
import { goIn, setHour } from './room-helpers'

/**
 * The library, revised after the owner's first playtest (docs/design/indoors.md
 * 3.3): the panel's four sections and the way a section's shelves open it
 * (src/game/library-open.ts), donating at Elara's desk instead of a shelf,
 * and Elara keeping the room half of each hour.
 */
type LibraryOpen = { focus?: 'shelf' | 'donate' | 'read'; section?: string }
const openLibrary = (page: Page, p: LibraryOpen) => page.evaluate((x) => (window as unknown as { __fsDevLibrary: (p: LibraryOpen) => void }).__fsDevLibrary(x), p)
const panel = (page: Page) => page.getByRole('dialog', { name: 'Hearthwick Library' })

test('a section’s shelves open the panel on it; an empty section opens the whole collection; no donating from the shelves', async ({ page }) => {
  await freshPlayer(page)
  await waitForLive(page)
  // The Stories shelves: songs and printed pages only (the library starts with some).
  await openLibrary(page, { focus: 'shelf', section: 'stories' })
  const lib = panel(page)
  await expect(lib.locator('[data-section="stories"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(lib.locator('[data-paper="the-reed-and-roll-mill-chant"]')).toBeVisible()
  await expect(lib.locator('[data-paper="oak-hall-edict-on-the-stealing-of-shade"]')).toHaveCount(0)
  await page.screenshot({ path: '.agent/screens/library-stories-desktop.png' })
  // Another sign: Histories.
  await lib.locator('[data-section="histories"]').click()
  await expect(lib.locator('[data-paper="oak-hall-edict-on-the-stealing-of-shade"]')).toBeVisible()
  await expect(lib.locator('[data-paper="the-reed-and-roll-mill-chant"]')).toHaveCount(0)
  // No Donate on the open shelves: that's Elara's.
  await expect(lib.locator('[data-donate]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(lib).toBeHidden()

  // Nothing on the Recipes shelves yet: the whole collection, and it says so.
  await openLibrary(page, { focus: 'shelf', section: 'recipes' })
  await expect(panel(page).locator('[data-section="all"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(panel(page).getByTestId('library-empty-section')).toContainText('Nothing on the Recipes shelves yet')
})

test('Elara’s desk: the papers you found that the shelves lack, and Donate', async ({ page }) => {
  const id = await freshPlayer(page)
  // Elara keeps the library from :10 to :40 (both clocks, so the world agrees once A's rule is in).
  await setHour(page, { minute: 20, server: true })
  seedMarks(id, 'paper:annotated-flora-of-the-eastern-reaches')
  await reenter(page)
  await openLibrary(page, { focus: 'donate' })
  const desk = panel(page).getByTestId('library-donate')
  await expect(desk).toContainText('Annotated Page from')
  await page.screenshot({ path: '.agent/screens/library-donate-desktop.png' })
  await desk.locator('[data-donate="annotated-flora-of-the-eastern-reaches"]').click()
  await expect(panel(page).getByTestId('library-message')).toContainText('is on the shelves now', { timeout: 15_000 })
  await expect(desk).toContainText('Nothing you carry is missing from the shelves')
  await desk.getByRole('button', { name: /The shelves/ }).click()
  await expect(panel(page).locator('[data-paper="annotated-flora-of-the-eastern-reaches"]')).toBeVisible()
})

test('Elara keeps the library: talking to her there opens the shelves (needs A’s cycle and B’s placement)', async ({ page }) => {
  test.setTimeout(120_000)
  await freshPlayer(page)
  await setHour(page, { minute: 20, server: true })
  await goIn(page, 'in:village:library')
  await expect(page.locator('.place-name .nm').first()).toHaveText('The library reading room')
  // Her desk (indoors.md 3.3, revised): find her wherever B seats her.
  const at = await page.evaluate(() => (window as unknown as { __fsNpcs: () => { id: string; x: number; y: number }[] }).__fsNpcs().find((n) => n.id === 'elara'))
  expect(at, 'Elara is in the library at :20').toBeTruthy()
  await warp(page, 'in:village:library', Math.floor(at!.x / 16), Math.floor(at!.y / 16) + 1)
  await openTalk(page, /Talk to Elara/)
  // A first meeting is her introduction, with the shelves offered after it.
  const choices = await untilChoices(page)
  expect(choices.map((c) => c.text)).toEqual(expect.arrayContaining(['Show me the shelves', 'I’ve a paper for the shelves']))
  expect((await dialogueState(page)).said.join(' ')).toContain('read the drift')
  await readDialogue(page, { pick: /Show me the shelves/ })
  await expect(panel(page).locator('[data-section="all"]')).toHaveAttribute('aria-pressed', 'true')
})
