import { expect, test, type Page } from './fixtures'
import { beginNewJourney, talkThrough, waitForArea, warp } from './helpers'

/** Found-text pickups still lying in the current area (read-only hook). */
async function lying(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __fsPapers: () => string[] }).__fsPapers())
}

/** The saved story flags, straight from IndexedDB. */
async function savedFlags(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const rec = await new Promise<{ state?: { flags?: string[] } } | undefined>((resolve) => {
        const req = db.transaction('saves').objectStore('saves').get('current')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
      })
      return rec?.state?.flags ?? []
    } finally {
      db.close()
    }
  })
}

const PIP_PAGE = 'pip-copybook-warden-corrections'

async function pickUpPipsPage(page: Page): Promise<void> {
  // Inside the garden fence, one tile below the page in its far corner.
  await warp(page, 'village', 25, 15)
  expect(await lying(page)).toContain(PIP_PAGE)
  await expect(page.locator('.prompt')).toContainText('Pick up the folded paper')
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: 'Found: A Page from Pip’s Copybook' })).toBeVisible()
  expect(await lying(page)).not.toContain(PIP_PAGE)
  await expect.poll(() => savedFlags(page)).toContain(`paper:${PIP_PAGE}`)
}

test('pick up a paper in the world, read it in the journal, and it stays found after a reload', async ({ page }) => {
  await beginNewJourney(page)
  await pickUpPipsPage(page)

  // The journal button carries a "new" dot until the page is read.
  const journalButton = page.getByRole('button', { name: /Journal \(J\), 1 new paper/ })
  await expect(journalButton).toBeVisible()
  await journalButton.click()
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await journal.getByRole('tab', { name: /Papers/ }).click()
  await expect(journal.getByText('1 of 28 found', { exact: false })).toBeVisible()
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
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
  await warp(page, 'village', 25, 15)
  expect(await lying(page)).not.toContain(PIP_PAGE)
  await page.keyboard.press('j')
  await page.getByRole('dialog', { name: 'Journal' }).getByRole('tab', { name: /Papers/ }).click()
  await expect(page.getByRole('button', { name: /A Page from Pip’s Copybook/ })).toBeVisible()
})

test('the Hearthwick Library: read the starting shelf, donate a find, and the shelf remembers', async ({ page }) => {
  await beginNewJourney(page)
  await pickUpPipsPage(page)

  // The library door, on the square's south-west corner.
  await warp(page, 'village', 3, 18)
  await expect(page.locator('.prompt')).toContainText('Enter the Hearthwick Library')
  await page.keyboard.press('e')
  const library = page.getByRole('dialog', { name: 'Hearthwick Library' })
  await expect(library).toBeVisible()
  await expect(library.getByText('11 of 39')).toBeVisible()

  // Everyone can read the starting shelf from day one.
  await library.getByRole('button', { name: /The Oak Hall Edict on the Stealing of Shade/ }).click()
  await expect(library.getByRole('article', { name: 'The Oak Hall Edict on the Stealing of Shade' })).toContainText('Stealing Shade')
  await expect(library.getByText('On the shelves since the Keepers’ day.')).toBeVisible()
  await library.getByRole('button', { name: /The shelves/ }).click()

  // Donate the page we found.
  await library.locator(`[data-donate="${PIP_PAGE}"]`).click()
  await expect(library.getByText('12 of 39')).toBeVisible()
  await expect(library.getByRole('button', { name: /A Page from Pip’s Copybook.*First donated by Wren/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(library).toBeHidden()

  // Donating keeps the page in your own collection, and the shelf survives a reload.
  await expect.poll(async () => (await savedFlags(page)).some((f) => f.startsWith(`donated:${PIP_PAGE}@`))).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
  await warp(page, 'village', 3, 18)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: 'Hearthwick Library' }).getByText('12 of 39')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('j')
  await page.getByRole('dialog', { name: 'Journal' }).getByRole('tab', { name: /Papers/ }).click()
  await expect(page.getByRole('button', { name: /A Page from Pip’s Copybook/ })).toBeVisible()
})

test('Mara hands over the ledger pages once the closure mark is found', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /rubbing of the marker/)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expect(page.locator('.toast', { hasText: 'Found: The Ashwatch Ledger — Excerpts' })).toBeVisible()
  await expect.poll(() => savedFlags(page)).toContain('paper:ashwatch-ledger-excerpts')
})
