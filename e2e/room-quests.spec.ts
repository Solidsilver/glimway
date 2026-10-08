import { expect, test } from './fixtures'
import { freshPlayer } from './home-helpers'
import { dialogueState, expectAreaCard, readDialogue, waitForLive, warp } from './helpers'
import { goIn, inRoom, setHour } from './room-helpers'

/**
 * The seam between the rooms and the quests (docs/design/indoors.md 2.5,
 * 5.6): a room reads as itself on the area card and the HUD, and its spots
 * ask the quests first (src/game/room-spots.ts `setSpotQuests`). The sponge
 * bowl answers from Set to Rise even before Hazel has asked, so this runs
 * without A2.
 */
test('Hazel’s kitchen has its name on the card and the HUD, and the sponge bowl answers from the quest', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await setHour(page, { minute: 25 })
  await goIn(page, 'in:village:bakery')
  await expectAreaCard(page, 'Hazel’s kitchen')
  await expect(page.locator('.place-name .nm').first()).toHaveText('Hazel’s kitchen')
  await page.screenshot({ path: '.agent/screens/room-hud-title-desktop.png' })

  await warp(page, 'in:village:bakery', 10, 6)
  await inRoom(page, 'in:village:bakery')
  await expect(page.locator('.prompt')).toContainText('Look in the bowl')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: /Conversation with/ })).toBeVisible()
  await readDialogue(page)
  const said = (await dialogueState(page)).said.join(' ')
  // Set to Rise's words for the bowl (src/content/quests/set-to-rise.ts), not the room's default look.
  expect(said).toContain('Empty, and floured round the rim')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })

  test('a room’s name is the HUD’s place on a phone too', async ({ page }) => {
    // The first morning: no reload to get past the opening.
    await freshPlayer(page, 'Tansy', undefined, { opening: true })
    await setHour(page, { minute: 25 })
    await goIn(page, 'in:village:mill', { touch: true })
    await expect(page.locator('.place-name .nm').first()).toHaveText('Finn’s mill')
    await page.screenshot({ path: '.agent/screens/room-hud-title-phone.png' })
  })
})
