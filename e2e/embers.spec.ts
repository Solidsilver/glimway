import { expect, test, type Page } from '@playwright/test'
import { beginNewJourney, expectStage, strikeAll, talkThrough, warp } from './helpers'

/** Read the save's ember balance and flags straight from IndexedDB. */
async function savedEmbers(page: Page): Promise<{ embers: number; flags: string[]; hp: number; maxHp: number } | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const rec = await new Promise<{ state?: { embers: number; flags: string[]; hp: number; maxHp: number } } | undefined>((resolve) => {
        const req = db.transaction('saves').objectStore('saves').get('current')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
      })
      return rec?.state && { embers: rec.state.embers, flags: rec.state.flags, hp: rec.state.hp, maxHp: rec.state.maxHp }
    } finally {
      db.close()
    }
  })
}

const hud = (page: Page) => page.locator('.hud .embers')

test('a sample hero brings welcome embers, and a warm rest spends them', async ({ page }) => {
  await beginNewJourney(page)

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Try a sample hero' }).click()
  await expect(page.locator('.toast', { hasText: 'embers into your hand' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to the road' }).click()
  await expect(hud(page)).toHaveText('3')

  // Get hurt, then rest by the village lantern.
  await page.evaluate(() => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(6))
  await warp(page, 'village', 11, 13)
  await expect(page.locator('.prompt')).toContainText('Rest by the lantern')
  await page.keyboard.press('e')
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  for (let i = 0; i < 10 && !(await choice.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(choice).toBeEnabled()
  await expect(choice).toContainText('2 embers')
  await page.screenshot({ path: 'test-results/embers-hearth.png' })
  await page.keyboard.press('1')
  for (let i = 0; i < 10 && (await page.getByRole('dialog', { name: /Conversation/ }).isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(hud(page)).toHaveText('1')
  await expect.poll(async () => {
    const s = await savedEmbers(page)
    return s && s.hp === s.maxHp && s.embers === 1
  }).toBe(true)
})

test('quest embers light a road lantern; the chest says what it needs', async ({ page }) => {
  await beginNewJourney(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /rubbing of the marker/)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsEnemies: () => unknown[] }).__fsEnemies().length)).toBeGreaterThan(0)
  await strikeAll(page, 999)
  await expectStage(page, 'guardian-defeated')
  await expect(hud(page)).toHaveText('2')

  // The chest needs 5: the choice is shown but greyed out.
  await warp(page, 'ruin', 28, 3)
  await expect(page.locator('.prompt')).toContainText('Open the chest')
  await page.keyboard.press('e')
  const kindle = page.locator('.choice', { hasText: 'Kindle the lock' })
  for (let i = 0; i < 10 && !(await kindle.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(kindle).toBeDisabled()
  await expect(kindle).toContainText('Needs 5 embers')
  await page.screenshot({ path: 'test-results/embers-chest.png' })
  await page.keyboard.press('2')
  await expect(page.getByRole('dialog', { name: /Conversation/ })).toBeHidden()

  // Finish the quest for 3 more, then light the first road lantern.
  await warp(page, 'ruin', 17, 12)
  await talkThrough(page, /Light the lantern/)
  await expectStage(page, 'lantern-lit')
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectStage(page, 'complete')
  await page.getByRole('button', { name: 'Keep exploring' }).click()
  await expect(hud(page)).toHaveText('5')

  await warp(page, 'woodland', 10, 15)
  await talkThrough(page, /Light the lantern/)
  await expect(hud(page)).toHaveText('2')
  await expect.poll(async () => (await savedEmbers(page))?.flags ?? []).toContain('lit:road-1')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/embers-road-lit.png' })
})
