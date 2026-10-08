import { expect, test } from './fixtures'
import { expectStage, openTalk, readDialogue, settleWarden, talkThrough, untilChoices, warp } from './helpers'
import { earnEmbers, freshPlayer } from './home-helpers'
import { serverState } from './connected'

const hud = (page: import('@playwright/test').Page) => page.locator('.hud .embers')

/** The server's embers and vitals for this browser's session (as the client reads them). */
async function worldEmbers(page: import('@playwright/test').Page): Promise<{ embers: number; hp: number; maxHp: number } | undefined> {
  try {
    return (await serverState(page)).body.state
  } catch {
    return undefined
  }
}

test('quest embers light a road lantern; the chest says what it needs', async ({ page }) => {
  // The whole quest's dialogue is read through here; under a loaded run it
  // can outlast the default timeout.
  test.slow()
  const id = await freshPlayer(page)
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
  // The world's balance paid the light (the lit lantern itself is the world's outcome).
  await expect.poll(async () => (await worldEmbers(page))?.embers, { timeout: 15_000 }).toBe(2)
  await page.screenshot({ path: 'test-results/embers-road-lit.png' })
})

test('a warm rest spends embers from the world, and Habitica syncs bring them', async ({ page }) => {
  const id = await freshPlayer(page)
  // Two Habitica days: the welcome, then the earned embers to rest with.
  await earnEmbers(page, id)

  // Get hurt, then rest by the village lantern.
  await page.evaluate(() => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(6))
  await warp(page, 'village', 11, 13)
  await openTalk(page, 'Rest by the lantern')
  await untilChoices(page)
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  await expect(choice).toBeEnabled()
  await expect(choice).toContainText('2 embers')
  await page.screenshot({ path: 'test-results/embers-hearth.png' })
  const before = Number(await hud(page).textContent())
  await page.keyboard.press('1')
  await readDialogue(page)
  // The rest is paid from the world's balance, and the hurt is healed.
  await expect(hud(page)).toHaveText(String(before - 2))
  await expect.poll(async () => {
    const s = await worldEmbers(page)
    return !!s && Math.ceil(s.hp) === s.maxHp
  }, { timeout: 15_000 }).toBe(true)
})
