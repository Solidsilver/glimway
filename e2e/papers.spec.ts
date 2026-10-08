import { expect, test, type Page } from './fixtures'
import { expectStage, settleWarden, talkThrough, warp, expectToast } from './helpers'
import { freshPlayer } from './home-helpers'
import { reenter, serverState } from './connected'

/** Found-text pickups still lying in the current area (read-only hook). */
async function lying(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __fsPapers: () => string[] }).__fsPapers())
}

/** The story marks the world holds for this session. */
async function savedFlags(page: Page): Promise<string[]> {
  return (await serverState(page)).body.state.flags ?? []
}

const PIP_PAGE = 'pip-copybook-warden-corrections'

async function pickUpPipsPage(page: Page): Promise<void> {
  // Inside the garden fence, one tile below the page in its far corner.
  await warp(page, 'village', 25, 15)
  expect(await lying(page)).toContain(PIP_PAGE)
  await expect(page.locator('.prompt')).toContainText('Pick up the folded paper')
  await page.keyboard.press('e')
  await expectToast(page, 'Found: A Page from Pip’s Copybook')
  expect(await lying(page)).not.toContain(PIP_PAGE)
  await expect.poll(() => savedFlags(page)).toContain(`paper:${PIP_PAGE}`)
}

test('pick up a paper in the world, read it in the journal, and it stays found after a reload', async ({ page }) => {
  await freshPlayer(page)
  await pickUpPipsPage(page)

  // The journal button carries a "new" dot until the page is read.
  const journalButton = page.getByRole('button', { name: /Journal \(J\), 1 new paper/ })
  await expect(journalButton).toBeVisible()
  await journalButton.click()
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await journal.getByRole('tab', { name: /Papers/ }).click()
  await expect(journal.getByText('1 of 39 found', { exact: false })).toBeVisible()
  // Unfound papers show only what kind of thing they are and where to look.
  await expect(journal.getByText('Mara keeps her grandmother’s ledger. Bring her news from Ashwatch.')).toBeVisible()
  await expect(journal.getByText('Amber-wick, 3rd')).toHaveCount(0)

  await journal.getByRole('button', { name: /A Page from Pip’s Copybook/ }).click()
  const sheet = journal.getByRole('article', { name: 'A Page from Pip’s Copybook' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('My Scientific Corrections')
  await journal.getByRole('button', { name: /All papers/ }).click()
  await expect(journal.getByRole('button', { name: /A Page from Pip’s Copybook/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Journal (J)', exact: true })).toBeVisible()

  // Reload: still found, still gone from the garden.
  await reenter(page)
  await warp(page, 'village', 25, 15)
  expect(await lying(page)).not.toContain(PIP_PAGE)
  await page.keyboard.press('j')
  await page.getByRole('dialog', { name: 'Journal' }).getByRole('tab', { name: /Papers/ }).click()
  await expect(page.getByRole('button', { name: /A Page from Pip’s Copybook/ })).toBeVisible()
})

test('Mara hands over the ledger pages once the closure mark is found', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectToast(page, 'Found: The Ashwatch Ledger — Excerpts')
  await expect.poll(() => savedFlags(page)).toContain('paper:ashwatch-ledger-excerpts')
})

test('settling the warden opens its chest: Orrin’s “Eleven Days” is found', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await settleWarden(page)
  await expectStage(page, 'guardian-defeated')
  await expectToast(page, 'Found: Eleven Days', { timeout: 10_000 })
  await expect.poll(() => savedFlags(page)).toContain('paper:eleven-days')
})
