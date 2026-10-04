import { expect, test, type Page } from './fixtures'
import { beginNewJourney, waitForArea, warp } from './helpers'

/**
 * Screenshots of the found-texts library for review (.agent/screens/).
 * Skipped in the normal run: `SCREENS=1 npx playwright test e2e/papers-screens.spec.ts`.
 */
test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

const OUT = '.agent/screens'

/** Give the current save some finds (screenshots only), then come back in. */
async function seed(page: Page, flags: string[], quest = 'new'): Promise<void> {
  await page.waitForTimeout(800)
  await page.evaluate(
    async ([extra, stage]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('fingersnap')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const store = () => db.transaction('saves', 'readwrite').objectStore('saves')
      const rec = await new Promise<{ state: { flags: string[]; quest: string } }>((resolve) => {
        const req = store().get('current')
        req.onsuccess = () => resolve(req.result)
      })
      rec.state.flags = [...rec.state.flags, ...(extra as string[])]
      rec.state.quest = stage as string
      await new Promise((resolve) => {
        const req = store().put(rec)
        req.onsuccess = resolve
      })
      db.close()
    },
    [flags, quest] as const
  )
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
}

const FINDS = [
  'paper:ashwatch-ledger-excerpts',
  'paper:keepers-twists-recipe-card',
  'paper:will-of-elias-fenn',
  'paper:annotated-flora-of-the-eastern-reaches',
  'paper:orrins-workshop-rules',
  'paper:elaras-note-in-pips-copybook',
  'paper:note-in-the-linseed-box',
  'donated:will-of-elias-fenn@2026-10-02'
]

async function openPapers(page: Page) {
  await page.keyboard.press('j')
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await journal.getByRole('tab', { name: /Papers/ }).click()
  return journal
}

async function read(page: Page, journal: ReturnType<Page['getByRole']>, title: RegExp, file: string) {
  await journal.getByRole('button', { name: title }).first().click()
  await expect(journal.getByRole('article')).toBeVisible()
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${OUT}/${file}` })
  await journal.getByRole('button', { name: /All papers/ }).click()
}

test('desktop screens', async ({ page }) => {
  await beginNewJourney(page)
  await seed(page, FINDS, 'complete')

  // A pickup in the world (garden corner) and one in Brackenwood.
  await warp(page, 'village', 26, 14)
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/desktop-pickup-village.png` })
  await warp(page, 'woodland', 25, 10)
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/desktop-pickup-woodland.png` })
  await warp(page, 'ruin', 16, 19)
  await page.waitForTimeout(2600)
  await page.screenshot({ path: `${OUT}/desktop-pickup-ruin-slate.png` })

  // The library door.
  await warp(page, 'village', 3, 19)
  await page.screenshot({ path: `${OUT}/desktop-library-door.png` })

  const journal = await openPapers(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/desktop-papers-tab.png` })
  await page.locator('.overlay > .panel').evaluate((el) => el.scrollTo(0, 99999))
  await page.screenshot({ path: `${OUT}/desktop-papers-tab-bottom.png` })
  await page.locator('.overlay > .panel').evaluate((el) => el.scrollTo(0, 0))
  await read(page, journal, /Ashwatch Ledger/, 'desktop-read-ledger.png')
  await read(page, journal, /Recipe Card/, 'desktop-read-recipe-card.png')
  await read(page, journal, /Linseed Box/, 'desktop-read-letter.png')
  await read(page, journal, /Elias Fenn/, 'desktop-read-record.png')
  await read(page, journal, /Orrin’s Workshop/, 'desktop-read-scrap.png')
  await read(page, journal, /Flora of the Eastern Reaches/, 'desktop-read-page.png')
  await page.keyboard.press('Escape')

  // The reading room.
  await warp(page, 'village', 3, 18)
  await page.keyboard.press('e')
  const library = page.getByRole('dialog', { name: 'Hearthwick Library' })
  await expect(library.getByText(/of 39/)).toBeVisible()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/desktop-library.png` })
  await library.getByRole('button', { name: /Dangers of the White Quiet/ }).click()
  await page.screenshot({ path: `${OUT}/desktop-library-read-broadside.png` })
  await library.getByRole('button', { name: /The shelves/ }).click()
  await library.getByRole('button', { name: /Mudrise Fleet/ }).click()
  await page.screenshot({ path: `${OUT}/desktop-library-read-song.png` })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('phone screens', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Wander as a guest/ }).tap()
    await waitForArea(page, 'village')
    await seed(page, FINDS, 'complete')

    await warp(page, 'village', 26, 14)
    await page.waitForTimeout(2600)
    await page.screenshot({ path: `${OUT}/phone-pickup-village.png` })

    await page.getByRole('button', { name: /Journal/ }).tap()
    const journal = page.getByRole('dialog', { name: 'Journal' })
    await journal.getByRole('tab', { name: /Papers/ }).tap()
    await page.screenshot({ path: `${OUT}/phone-papers-tab.png` })
    await journal.getByRole('button', { name: /Recipe Card/ }).tap()
    await page.screenshot({ path: `${OUT}/phone-read-recipe-card.png` })
    await journal.getByRole('button', { name: /All papers/ }).tap()
    await journal.getByRole('button', { name: /Ashwatch Ledger/ }).tap()
    await page.screenshot({ path: `${OUT}/phone-read-ledger.png` })
    await page.getByRole('button', { name: 'Close journal' }).tap()

    await warp(page, 'village', 3, 18)
    await page.locator('.controls .act').tap()
    const library = page.getByRole('dialog', { name: 'Hearthwick Library' })
    await expect(library.getByText(/of 39/)).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/phone-library.png` })
  })
})
