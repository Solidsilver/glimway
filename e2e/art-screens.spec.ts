import { expect, test } from './fixtures'
import { beginNewJourney, settleWarden, talkThrough, waitForArea, waitForWilds, warden, warp } from './helpers'
import { atMyMailbox, claimDeed, earnPlenty, freshPlayer, fund, homes, intoCottage, myHome, onMyLand, place, readOn, shot as snap, silasSays, type Area } from './home-helpers'
import type { Page } from './fixtures'

/** Screens, then let the scene settle again (the phone resize relays out the game). */
async function shot(page: Page, name: string): Promise<void> {
  await snap(page, name)
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { transitioning: boolean } }).__fsSafety?.().transitioning === false)
  await page.waitForTimeout(500)
}

/** Dev warp that waits for the new area. */
const go = (page: Page, area: string, tx: number, ty: number) => warp(page, area as Parameters<typeof warp>[1], tx, ty)

/**
 * Screens for the Commons art pass review (.agent/screens/, desktop and
 * phone): a home at each tier, the workshop room, Silas with his portrait,
 * the UI panels with the delivered icons, and the settled warden.
 * SCREENS=1 only.
 */
test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')

test.describe('connected', () => {
  test.use({ server: true })

  test('homes at every tier, the workshop room, and the icon panels', async ({ page }) => {
    test.setTimeout(400_000)
    const id = await freshPlayer(page)
    await earnPlenty(page, id)
    fund(id, {
      materials: { timber: 60, stone: 30, fiber: 30, amber: 8 },
      items: { 'lamp-wick': 2, 'oilcloth-wrap': 1, 'wooden-peg': 3, 'whittled-fox': 1, 'tin-whistle': 1, 'beeswax-candle': 1 }
    })
    await claimDeed(page)
    const v = await homes(page)
    const s = v.features!.silas
    await onMyLand(page, 3, 2)
    await shot(page, 'art-home-tier0-desktop')

    // Silas, in conversation: the delivered bust.
    await go(page, 'commons', s.tx, s.ty + 1)
    await expect(page.locator('.prompt')).toContainText('Talk to Silas')
    await page.keyboard.press('e')
    await expect(page.getByRole('dialog', { name: /Conversation with/ })).toBeVisible()
    await page.waitForTimeout(1500)
    await shot(page, 'art-silas-dialogue-desktop')
    const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
    for (let i = 0; i < 20 && (await dialogue.isVisible()); i++) {
      const passing = page.locator('.choice', { hasText: /Just passing|Not today|Later/ })
      if (await passing.first().isVisible().catch(() => false)) await passing.first().click()
      else await page.keyboard.press('e')
      await page.waitForTimeout(250)
    }
    await expect(dialogue).toBeHidden()
    await go(page, 'commons', 23, 19)

    await silasSays(page, /Raise a cottage/)
    await readOn(page, /Steady as a route stone/)
    await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
    await onMyLand(page, 3, 2)
    await shot(page, 'art-home-tier1-desktop')
    await page.waitForTimeout(400)
    await silasSays(page, /Build on a workshop/)
    await readOn(page, /Steady|eaves/)
    await expect.poll(async () => (await myHome(page, id)).tier).toBe(2)
    await onMyLand(page, 3, 2)
    await shot(page, 'art-home-tier2-desktop')

    // Inside: the back wall, the hearth fire, the plank floor, chest and bench.
    await intoCottage(page)
    await place(page, 112, 120)
    await page.waitForTimeout(2500)
    await shot(page, 'art-interior-workshop-desktop')
    await place(page, 40, 66)
    await expect(page.locator('.prompt')).toContainText('Open the chests')
    await page.waitForTimeout(200)
    await page.keyboard.press('e')
    const panel = page.getByRole('dialog', { name: 'The Workshop' })
    await expect(panel).toBeVisible()
    await shot(page, 'art-ui-storage-desktop')
    await panel.getByRole('tab', { name: 'Crafting bench' }).click()
    await shot(page, 'art-ui-crafting-desktop')
    await page.keyboard.press('Escape')

    // The mailbox's goods, the Character panel's pack and materials.
    await atMyMailbox(page)
    await expect(page.locator('.prompt')).toContainText('Check your mailbox')
    await page.waitForTimeout(200)
    await page.keyboard.press('e')
    const mail = page.getByRole('dialog', { name: 'Mailbox' })
    await mail.getByRole('tab', { name: 'Send something' }).click()
    await shot(page, 'art-ui-mail-desktop')
    await page.keyboard.press('Escape')
    await warp(page, 'wilds', 2, 22)
    await waitForWilds(page)
    await page.keyboard.press('c')
    await expect(page.locator('[aria-labelledby="char-title"]')).toBeVisible()
    await page.getByTestId('material-timber').scrollIntoViewIfNeeded()
    await shot(page, 'art-ui-character-desktop')
    await page.keyboard.press('Escape')
    await page.getByTestId('emote-button').click()
    await expect(page.getByTestId('emote-picker')).toBeVisible()
    await shot(page, 'art-ui-emotes-desktop')
  })
})

test('the settled warden at its post', async ({ page }) => {
  test.setTimeout(150_000)
  await beginNewJourney(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await settleWarden(page)
  const w = await warden(page)
  await page.waitForTimeout(4500)
  await shot(page, 'art-warden-settling-desktop')
  // Back later: it rests on its post (the scene rebuilds it settled).
  await warp(page, 'woodland', 2, 15)
  await warp(page, 'ruin', Math.floor(w.x / 16) - 2, Math.floor(w.y / 16))
  await page.waitForTimeout(4500)
  await shot(page, 'art-warden-settled-desktop')
})
