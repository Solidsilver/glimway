import { expect, test } from './fixtures'
import {
  beginNewJourney,
  dialogueState,
  expectToast,
  openTalk,
  readDialogue,
  savedFlags,
  seedSave,
  untilChoices,
  waitForLive,
  warp
} from './helpers'

/**
 * Heirloom tools story beats (BRIEF.md):
 *  - Orrin gives Orrin's mason pick once the north bridge is mended.
 *  - Silas brings out the Brack felling axe once Hollis's name is known.
 */

test.describe('heirloom story beats', () => {
  test('Orrin gives his mason pick once the north bridge is mended', async ({ page }) => {
    await beginNewJourney(page)
    await seedSave(page, ['project:north-bridge:complete'], 'clue-found')

    // Stand by Orrin in Village (tx: 21, ty: 9)
    await warp(page, 'village', 21, 10)
    await expect(page.locator('.prompt')).toContainText('Talk to Orrin')
    await waitForLive(page)

    // Open conversation
    await openTalk(page, 'Talk to Orrin')
    const state = await dialogueState(page)
    expect(state.speaker).toBe('Orrin')

    // Read lines and accept the pick
    const choices = await untilChoices(page)
    expect(choices.some((c) => /Take Orrin’s mason pick/i.test(c.text))).toBe(true)

    await readDialogue(page, { pick: /Take Orrin’s mason pick/i })
    await expectToast(page, 'Orrin gave you his mason pick.')

    await expect.poll(async () => savedFlags(page)).toContain('heirloom:orrins-mason-pick')
  })

  test('Silas gives the Brack felling axe once Hollis’s name is known', async ({ page }) => {
    await beginNewJourney(page)
    await seedSave(page, ['paper:ashwatch-ledger-excerpts'], 'new')

    // Stand by Silas in Commons (tx: 51, ty: 21)
    await warp(page, 'commons', 51, 22)
    await expect(page.locator('.prompt')).toContainText('Talk to Silas')
    await waitForLive(page)

    // Open conversation
    await openTalk(page, 'Talk to Silas')
    const state = await dialogueState(page)
    expect(state.speaker).toBe('Silas')

    // Read lines and accept the axe
    const choices = await untilChoices(page)
    expect(choices.some((c) => /Take the Brack felling axe/i.test(c.text))).toBe(true)

    await readDialogue(page, { pick: /Take the Brack felling axe/i })
    await expectToast(page, 'Silas gave you the Brack felling axe.')

    await expect.poll(async () => savedFlags(page)).toContain('heirloom:brack-felling-axe')
  })
})
