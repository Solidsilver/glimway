import { expect, test } from './fixtures'
import { expectStage, openTalk, readDialogue, settleWarden, talkThrough, untilChoices, warp } from './helpers'
import { earnGlims, freshPlayer } from './home-helpers'
import { serverState } from './connected'

const hud = (page: import('@playwright/test').Page) => page.locator('.hud .glims')

/** The server's glims, vitals and story marks for this session (as the client reads them). */
async function worldGlims(page: import('@playwright/test').Page): Promise<{ glims: number; hp: number; maxHp: number; flags: string[] } | undefined> {
  try {
    return (await serverState(page)).body.state
  } catch {
    return undefined
  }
}

test('quest glims light a road lantern; the chest says what it needs', async ({ page }) => {
  // The whole quest's dialogue is read through here; under a loaded run it
  // can outlast the default timeout.
  test.slow()
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await settleWarden(page)
  await expectStage(page, 'guardian-defeated')
  await expect(hud(page)).toHaveText('2')

  // The chest needs 5: the choice is shown but greyed out.
  await warp(page, 'ruin', 28, 3)
  await openTalk(page, 'Open the chest')
  await untilChoices(page)
  const kindle = page.locator('.choice', { hasText: 'Kindle the lock' })
  await expect(kindle).toBeDisabled()
  await expect(kindle).toContainText('Needs 5 glims')
  await page.screenshot({ path: 'test-results/glims-chest.png' })
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
  // The world paid the light, and keeps the lit lantern as its mark.
  await expect.poll(async () => (await worldGlims(page))?.glims, { timeout: 15_000 }).toBe(2)
  await expect.poll(async () => (await worldGlims(page))?.flags ?? [], { timeout: 15_000 }).toContain('lit:road-1')
  await page.screenshot({ path: 'test-results/glims-road-lit.png' })
})

test('a warm rest spends glims from the world, and Habitica syncs bring them', async ({ page }) => {
  const id = await freshPlayer(page)
  // Two Habitica days: the welcome, then the earned glims to rest with.
  await earnGlims(page, id)

  // Get hurt, then rest by the village lantern.
  await page.evaluate(() => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(6))
  await warp(page, 'village', 11, 13)
  await openTalk(page, 'Rest by the lantern')
  await untilChoices(page)
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  await expect(choice).toBeEnabled()
  await expect(choice).toContainText('2 glims')
  await page.screenshot({ path: 'test-results/glims-hearth.png' })
  const before = Number(await hud(page).textContent())
  await page.keyboard.press('1')
  await readDialogue(page)
  // The rest is paid from the world's balance, and the hurt is healed.
  await expect(hud(page)).toHaveText(String(before - 2))
  await expect.poll(async () => {
    const s = await worldGlims(page)
    return !!s && Math.ceil(s.hp) === s.maxHp
  }, { timeout: 15_000 }).toBe(true)
})
